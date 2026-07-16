// /api/index.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ---------- INITIALISATION FIREBASE ADMIN ----------
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT non définie dans les variables d\'environnement');
}
let serviceAccount;
try {
    serviceAccount = JSON.parse(serviceAccountJson);
} catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT n\'est pas un JSON valide');
}
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// ---------- CONSTANTES ----------
const EXO_API_URL = 'https://exosupplier.com/api/v2';
const USD_TO_XAF = 615;
const PROFIT_MULTIPLIER = 1.5;

// ---------- FONCTIONS UTILITAIRES ----------
async function verifyToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Token manquant ou invalide');
    }
    const token = authHeader.split('Bearer ')[1];
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return decoded;
    } catch (error) {
        throw new Error('Token invalide');
    }
}

async function fetchExoServices() {
    const params = new URLSearchParams();
    params.append('key', process.env.EXO_SUPPLIER_API_KEY);
    params.append('action', 'services');
    const response = await fetch(EXO_API_URL, {
        method: 'POST',
        body: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!response.ok) {
        throw new Error(`Erreur Exo: ${response.status}`);
    }
    return await response.json();
}

async function placeExoOrder(serviceId, link, quantity, comments) {
    const params = new URLSearchParams();
    params.append('key', process.env.EXO_SUPPLIER_API_KEY);
    params.append('action', 'add');
    params.append('service', serviceId);
    params.append('link', link);
    if (comments && comments.length) {
        params.append('comments', comments.join('\n'));
    } else {
        params.append('quantity', quantity);
    }
    const response = await fetch(EXO_API_URL, {
        method: 'POST',
        body: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return await response.json();
}

async function getExoStatus(exoOrderId) {
    const params = new URLSearchParams();
    params.append('key', process.env.EXO_SUPPLIER_API_KEY);
    params.append('action', 'status');
    params.append('order', exoOrderId);
    const response = await fetch(EXO_API_URL, {
        method: 'POST',
        body: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return await response.json();
}

// ---------- EXPRESS APP ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- ROUTES ----------
// GET /api/exo/services
app.get('/api/exo/services', async (req, res) => {
    try {
        const services = await fetchExoServices();
        res.status(200).json(services);
    } catch (error) {
        console.error('Erreur chargement services:', error);
        res.status(500).json({ error: 'Erreur lors du chargement des services' });
    }
});

// POST /api/exo/order
app.post('/api/exo/order', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const uid = decoded.uid;

        const { service, link, quantity, serviceName, platform, price, comments } = req.body;

        if (!service || !link || !quantity) {
            return res.status(400).json({ error: 'Données manquantes' });
        }

        const exoServices = await fetchExoServices();
        const exoService = exoServices.find(s => s.service == service);
        if (!exoService) {
            return res.status(400).json({ error: 'Service invalide' });
        }

        const rateXAF = parseFloat(exoService.rate) * USD_TO_XAF * PROFIT_MULTIPLIER;
        let cost = 0;
        if (exoService.type === 'Custom Comments') {
            const commentsArray = comments || [];
            cost = (rateXAF / 1000) * commentsArray.length;
        } else {
            cost = (rateXAF / 1000) * quantity;
        }

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'Utilisateur introuvable' });
        }
        const userData = userDoc.data();
        const currentBalance = userData.balance || 0;
        if (currentBalance < cost) {
            return res.status(400).json({ error: 'Solde insuffisant' });
        }

        let exoResult;
        try {
            exoResult = await placeExoOrder(service, link, quantity, comments);
            if (exoResult.error) {
                return res.status(400).json({ error: 'Erreur fournisseur: ' + exoResult.error });
            }
        } catch (err) {
            console.error('Erreur Exo order:', err);
            return res.status(500).json({ error: 'Erreur lors de la commande chez le fournisseur' });
        }

        let finalOrderId;
        let newBalance;
        await db.runTransaction(async (transaction) => {
            const counterRef = db.collection('counters').doc('commandes');
            const counterDoc = await transaction.get(counterRef);
            let nextId = 1;
            if (counterDoc.exists && counterDoc.data().lastId) {
                nextId = counterDoc.data().lastId + 1;
            }
            finalOrderId = `SBH-${nextId}`;

            const userRef2 = db.collection('users').doc(uid);
            const userDoc2 = await transaction.get(userRef2);
            const balance = userDoc2.data().balance || 0;
            newBalance = balance - cost;
            transaction.update(userRef2, { balance: newBalance });

            transaction.set(counterRef, { lastId: nextId }, { merge: true });

            const orderRef = db.collection('commandes').doc();
            transaction.set(orderRef, {
                orderId: finalOrderId,
                userId: uid,
                exoOrderId: exoResult.order,
                serviceId: service,
                serviceName: serviceName || exoService.name,
                platform: platform || 'Autre',
                link: link,
                quantity: exoService.type === 'Custom Comments' ? (comments ? comments.length : 0) : quantity,
                cost: cost,
                status: 'En attente',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                contactInfo: null
            });
        });

        // Mise à jour des statistiques utilisateur
        const userRefStats = db.collection('users').doc(uid);
        await userRefStats.update({
            totalOrders: admin.firestore.FieldValue.increment(1),
            totalSpent: admin.firestore.FieldValue.increment(cost),
            activeOrders: admin.firestore.FieldValue.increment(1)
        });

        const updatedUser = await userRefStats.get();
        const updatedData = updatedUser.data();

        res.status(200).json({
            order: exoResult.order,
            newBalance: newBalance,
            totalOrders: updatedData.totalOrders || 0,
            activeOrders: updatedData.activeOrders || 0,
            totalSpent: updatedData.totalSpent || 0
        });
    } catch (error) {
        console.error('Erreur POST /api/exo/order:', error);
        res.status(500).json({ error: error.message || 'Erreur serveur' });
    }
});

// GET /api/orders/:uid
app.get('/api/orders/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const decoded = await verifyToken(req);
        if (decoded.uid !== uid) {
            return res.status(403).json({ error: 'Accès refusé' });
        }

        const ordersSnapshot = await db.collection('commandes')
            .where('userId', '==', uid)
            .orderBy('createdAt', 'desc')
            .get();

        const orders = [];
        for (const doc of ordersSnapshot.docs) {
            const data = doc.data();
            let status = data.status;
            let remains = data.remains || 0;
            if (data.exoOrderId) {
                try {
                    const exoStatus = await getExoStatus(data.exoOrderId);
                    if (exoStatus && exoStatus.status) {
                        const raw = exoStatus.status.toLowerCase();
                        if (raw === 'pending') status = 'En attente';
                        else if (raw === 'processing' || raw === 'in progress') status = 'En cours';
                        else if (raw === 'completed') status = 'Succès';
                        else if (raw === 'partial') status = 'Partiel';
                        else if (raw === 'canceled') status = 'Annulée';
                        else status = exoStatus.status;
                        remains = exoStatus.remains || 0;
                    }
                } catch (e) {
                    console.warn('Erreur mise à jour statut Exo pour', data.exoOrderId);
                }
            }
            orders.push({
                id: doc.id,
                orderId: data.orderId,
                platform: data.platform || 'Autre',
                serviceName: data.serviceName || '',
                link: data.link || '',
                quantity: data.quantity || 0,
                cost: data.cost || 0,
                status: status,
                remains: remains,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        }

        res.status(200).json({ orders });
    } catch (error) {
        console.error('Erreur GET /api/orders/:uid:', error);
        res.status(500).json({ error: error.message || 'Erreur serveur' });
    }
});

// ---------- EXPORT POUR VERCEL ----------
module.exports = app;