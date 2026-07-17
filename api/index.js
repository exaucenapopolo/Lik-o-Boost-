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

async function refillExoOrder(exoOrderId) {
    const params = new URLSearchParams();
    params.append('key', process.env.EXO_SUPPLIER_API_KEY);
    params.append('action', 'refill');
    params.append('order', exoOrderId);
    const response = await fetch(EXO_API_URL, {
        method: 'POST',
        body: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return await response.json();
}

async function cancelExoOrder(exoOrderId) {
    const params = new URLSearchParams();
    params.append('key', process.env.EXO_SUPPLIER_API_KEY);
    params.append('action', 'cancel');
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
            .get();

        const orders = [];
        for (const doc of ordersSnapshot.docs) {
            const data = doc.data();
            let status = data.status;
            let remains = data.remains !== undefined ? data.remains : 0;
            let startCount = data.startCount !== undefined ? data.startCount : 0;

            const isFinalStatus = status === 'Succès' || status === 'Terminée' || status === 'Annulée' || status === 'Échouée';
            if (data.exoOrderId && !isFinalStatus) {
                try {
                    const exoStatus = await getExoStatus(data.exoOrderId);
                    if (exoStatus && exoStatus.status) {
                        const raw = exoStatus.status.toLowerCase();
                        if (raw === 'pending') status = 'En attente';
                        else if (raw === 'processing' || raw === 'in progress') status = 'En cours';
                        else if (raw === 'completed') status = 'Succès';
                        else if (raw === 'partial') status = 'Partiel';
                        else if (raw === 'canceled' || raw === 'cancelled') status = 'Annulée';
                        else status = exoStatus.status;
                        
                        remains = exoStatus.remains !== undefined ? exoStatus.remains : remains;
                        startCount = exoStatus.start_count !== undefined ? exoStatus.start_count : startCount;

                        db.collection('commandes').doc(doc.id).update({
                            status: status,
                            remains: remains,
                            startCount: startCount,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        }).catch(e => console.error("background update error:", e));
                    }
                } catch (e) {
                    console.warn('Erreur mise à jour statut Exo pour', data.exoOrderId, e);
                }
            }

            orders.push({
                id: doc.id,
                orderId: data.orderId,
                platform: data.platform || 'Autre',
                serviceName: data.serviceName || data.service || '',
                link: data.link || '',
                quantity: data.quantity || 0,
                cost: data.cost || data.totalCost || 0,
                status: status,
                remains: remains,
                startCount: startCount,
                createdAt: data.createdAt ? (typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : new Date(data.createdAt).toISOString()) : null,
                customComments: data.customComments || data.commentaires || data.commentaires_personnalises || data.comments || '',
                contactInfo: data.contactInfo || data.contact || null,
                quality: data.quality || 'Standard',
                isAutoOrder: !!data.exoOrderId,
                exoOrderId: data.exoOrderId || null
            });
        }

        orders.sort((a, b) => {
            const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
            const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
            return dateB - dateA;
        });

        res.status(200).json({ orders });
    } catch (error) {
        console.error('Erreur GET /api/orders/:uid:', error);
        res.status(500).json({ error: error.message || 'Erreur serveur' });
    }
});

// POST /api/exo-status
app.post('/api/exo-status', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: 'ID de commande manquant' });
        }

        const orderRef = db.collection('commandes').doc(orderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
            return res.status(404).json({ error: 'Commande introuvable' });
        }

        const data = orderDoc.data();
        if (data.userId !== decoded.uid) {
            return res.status(403).json({ error: 'Accès refusé' });
        }

        let status = data.status;
        let remains = data.remains !== undefined ? data.remains : 0;
        let startCount = data.startCount !== undefined ? data.startCount : 0;

        if (data.exoOrderId) {
            const exoStatus = await getExoStatus(data.exoOrderId);
            if (exoStatus && exoStatus.status) {
                const raw = exoStatus.status.toLowerCase();
                if (raw === 'pending') status = 'En attente';
                else if (raw === 'processing' || raw === 'in progress') status = 'En cours';
                else if (raw === 'completed') status = 'Succès';
                else if (raw === 'partial') status = 'Partiel';
                else if (raw === 'canceled' || raw === 'cancelled') status = 'Annulée';
                else status = exoStatus.status;

                remains = exoStatus.remains !== undefined ? exoStatus.remains : remains;
                startCount = exoStatus.start_count !== undefined ? exoStatus.start_count : startCount;

                await orderRef.update({
                    status: status,
                    remains: remains,
                    startCount: startCount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }

        res.status(200).json({ success: true, status: status, remains: remains, startCount: startCount });
    } catch (error) {
        console.error('Erreur POST /api/exo-status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/exo/refill
app.post('/api/exo/refill', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const { orderId } = req.body;

        const orderRef = db.collection('commandes').doc(orderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
            return res.status(404).json({ error: 'Commande introuvable' });
        }

        const data = orderDoc.data();
        if (data.userId !== decoded.uid) {
            return res.status(403).json({ error: 'Accès refusé' });
        }

        if (!data.exoOrderId) {
            return res.status(400).json({ error: 'ID fournisseur manquant' });
        }

        const refillResult = await refillExoOrder(data.exoOrderId);
        if (refillResult.error) {
            return res.status(400).json({ success: false, error: 'Fournisseur: ' + refillResult.error });
        }

        res.status(200).json({ success: true, result: refillResult });
    } catch (error) {
        console.error('Erreur POST /api/exo/refill:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/exo/cancel
app.post('/api/exo/cancel', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const { orderId } = req.body;

        const orderRef = db.collection('commandes').doc(orderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
            return res.status(404).json({ error: 'Commande introuvable' });
        }

        const data = orderDoc.data();
        if (data.userId !== decoded.uid) {
            return res.status(403).json({ error: 'Accès refusé' });
        }

        if (data.status === 'Annulée' || data.status === 'Canceled') {
            return res.status(400).json({ error: 'Commande déjà annulée' });
        }

        let refundAmount = Number(data.cost || data.totalCost || 0);

        if (refundAmount > 0) {
            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(decoded.uid);
                const userDoc = await transaction.get(userRef);
                if (userDoc.exists) {
                    const currentBalance = userDoc.data().balance || 0;
                    const newBalance = currentBalance + refundAmount;
                    transaction.update(userRef, { balance: newBalance });
                }
                transaction.update(orderRef, {
                    status: 'Annulée',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
        } else {
            await orderRef.update({
                status: 'Annulée',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(200).json({ success: true, refundAmount: refundAmount });
    } catch (error) {
        console.error('Erreur POST /api/exo/cancel:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// NOUVELLES ROUTES FAPSHI (DÉPÔTS)
// ==========================================

// 1. Initialiser le paiement
app.post('/api/create-fapshi-checkout', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const { amount, description, email, name } = req.body;
        
        if (!process.env.FAPSHI_API_USER || !process.env.FAPSHI_API_KEY) {
            throw new Error('Identifiants API Fapshi manquants dans les variables d\'environnement');
        }

        const txRef = db.collection('fapshiTransactions').doc();
        
        const fapshiHeaders = {
            'apiuser': process.env.FAPSHI_API_USER,
            'apikey': process.env.FAPSHI_API_KEY,
            'Content-Type': 'application/json'
        };
        
        const fapshiBody = {
            amount: amount,
            email: email || 'client@likeoboost.com',
            externalId: txRef.id,
            redirectUrl: req.headers.origin + '/depot.html' // Assure-toi que cette page existe côté front !
        };
        
        const fapshiRes = await fetch('https://live.fapshi.com/initiate-pay', {
            method: 'POST',
            headers: fapshiHeaders,
            body: JSON.stringify(fapshiBody)
        });
        
        const fapshiData = await fapshiRes.json();
        
        if (!fapshiRes.ok || !fapshiData.link) {
            console.error('Erreur Fapshi:', fapshiData);
            throw new Error('Erreur de communication avec l\'API Fapshi.');
        }
        
        await txRef.set({
            userId: decoded.uid,
            amount: amount,
            description: description || 'Recharge de solde Likéo Boost',
            status: 'PENDING',
            dateInitiated: admin.firestore.FieldValue.serverTimestamp(),
            transId: fapshiData.transId,
            checkoutUrl: fapshiData.link
        });
        
        res.status(200).json({ checkoutUrl: fapshiData.link, transId: fapshiData.transId });
    } catch (err) {
        console.error('Erreur create-fapshi-checkout:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Vérification manuelle et automatique du statut Fapshi
app.post('/api/fapshi/verify-transaction', async (req, res) => {
    try {
        const decoded = await verifyToken(req);
        const { transId } = req.body;
        
        const txSnapshot = await db.collection('fapshiTransactions').where('transId', '==', transId).get();
        if (txSnapshot.empty) {
            return res.status(404).json({ error: 'Transaction introuvable dans la base de données.' });
        }
        
        const txDoc = txSnapshot.docs[0];
        const txData = txDoc.data();
        
        if (txData.userId !== decoded.uid) {
            return res.status(403).json({ error: 'Accès refusé' });
        }
        
        if (txData.status === 'CONFIRMED') {
            return res.status(200).json({ success: true, status: 'CONFIRMED' });
        }
        
        const fapshiHeaders = {
            'apiuser': process.env.FAPSHI_API_USER,
            'apikey': process.env.FAPSHI_API_KEY
        };
        
        const fapshiRes = await fetch(`https://live.fapshi.com/payment-status/${transId}`, {
            headers: fapshiHeaders
        });
        const fapshiData = await fapshiRes.json();
        
        if (fapshiData.status === 'SUCCESSFUL') {
            await db.runTransaction(async (t) => {
                const userRef = db.collection('users').doc(decoded.uid);
                const userDoc = await t.get(userRef);
                const currentBalance = userDoc.data().balance || 0;
                
                t.update(userRef, { balance: currentBalance + txData.amount });
                t.update(txDoc.ref, { 
                    status: 'CONFIRMED', 
                    dateConfirmed: admin.firestore.FieldValue.serverTimestamp() 
                });
            });
            return res.status(200).json({ success: true, status: 'CONFIRMED' });
            
        } else if (fapshiData.status === 'FAILED' || fapshiData.status === 'EXPIRED') {
            await txDoc.ref.update({ status: 'FAILED' });
            return res.status(200).json({ success: true, status: 'FAILED' });
        } else {
            return res.status(200).json({ success: true, status: 'PENDING' });
        }
    } catch (err) {
        console.error('Erreur verify-transaction:', err);
        res.status(500).json({ error: err.message });
    }
});


// ---------------------------------------------------------
// 1. ROUTE : CRÉER UNE TRANSACTION SWYCHR (AccountPe)
// ---------------------------------------------------------
app.post('/api/create-swychr', async (req, res) => {
    try {
        const { email, userId, username, country, phone, amount, amountXAF, currency } = req.body;

        // Authentification auprès de Swychr
        const authRes = await fetch('https://api.accountpe.com/api/payin/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: process.env.ACCOUNTPE_USERNAME,
                password: process.env.ACCOUNTPE_PASSWORD
            })
        });

        const authData = await authRes.json();
        if (!authData.token) throw new Error('Échec de l\'authentification Swychr');

        // Génération de l'ID incrémenté
        const counterRef = db.collection('counters').doc('transactions');
        const transactionId = await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);
            let currentCount = counterDoc.exists ? (counterDoc.data().count || 0) : 0;
            const nextCount = currentCount + 1;
            transaction.set(counterRef, { count: nextCount }, { merge: true });
            return `LIKEO-PAY-${nextCount}`; // Adapté pour Likéo Boost
        });

        // Host pour le callback
        const host = req.headers.host || 'likeoboost.com'; 
        const baseUrl = `https://${host}`;

        // Enregistrement dans Firestore
        await db.collection('transactions').doc(transactionId).set({
            userId,
            username: username || 'Client',
            email,
            phone: phone || '',
            country,
            amount,
            amountXAF,
            currency,
            status: 'pending',
            type: 'Recharge',
            label: `Recharge Swychr (${currency})`,
            createdAt: admin.firestore.FieldValue.serverTimestamp() // Sécurisé et précis
        });

        // Création du lien chez Swychr
        const paymentRes = await fetch('https://api.accountpe.com/api/payin/create_payment_links', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authData.token}`,
                'Idempotency-Key': transactionId
            },
            body: JSON.stringify({
                country_code: country,
                name: username || 'Client',
                email: email,
                mobile: phone || '',
                amount: amount,
                currency: currency,
                transaction_id: transactionId,
                description: 'Recharge Solde Likéo Boost',
                pass_digital_charge: true,
                callback_url: `${baseUrl}/api/webhook-swychr`
            })
        });

        const paymentData = await paymentRes.json();

        if (paymentData.status === 200 || paymentData.status === 201) {
            return res.status(200).json({ success: true, checkoutUrl: paymentData.data.payment_link, transactionId });
        } else {
            throw new Error(paymentData.message || 'Erreur API Swychr');
        }
    } catch (error) {
        console.error('Erreur create-swychr:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ---------------------------------------------------------
// 2. ROUTE : CONFIRMER UNE TRANSACTION (Manuel / Polling)
// ---------------------------------------------------------
app.get('/api/confirm-swychr', async (req, res) => {
    const { transactionId } = req.query;
    if (!transactionId) return res.status(400).json({ error: 'ID manquant' });

    try {
        const authRes = await fetch('https://api.accountpe.com/api/payin/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: process.env.ACCOUNTPE_USERNAME,
                password: process.env.ACCOUNTPE_PASSWORD
            })
        });

        const authData = await authRes.json();
        if (!authData.token) throw new Error("Impossible de s'authentifier chez Swychr");

        const statusRes = await fetch('https://api.accountpe.com/api/payin/payment_link_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authData.token}` },
            body: JSON.stringify({ transaction_id: transactionId })
        });

        const statusData = await statusRes.json();
        const attributes = statusData?.data?.data?.attributes || statusData?.data?.attributes || {};
        const rawStatus = String(attributes.status || "inconnu").toLowerCase().trim();

        const statusSucces = ["1", "success", "completed", "terminé", "succès", "reussi", "successful", "paid"];
        const statusEchec = ["-1", "2", "failed", "echec", "annulé", "cancelled", "rejected", "error"];
        
        let interpretedStatus = "pending";
        if (statusSucces.includes(rawStatus)) interpretedStatus = "success";
        else if (statusEchec.includes(rawStatus)) interpretedStatus = "failed";

        const txRef = db.collection('transactions').doc(transactionId);
        
        const result = await db.runTransaction(async (transaction) => {
            const txDoc = await transaction.get(txRef);
            if (!txDoc.exists) throw new Error("Transaction introuvable");

            const txData = txDoc.data();
            if (txData.status === 'completed') return { finalStatus: 'success', message: 'Déjà crédité' };

            if (interpretedStatus === 'success') {
                const userRef = db.collection('users').doc(txData.userId);
                transaction.update(userRef, {
                    balance: admin.firestore.FieldValue.increment(Number(txData.amountXAF))
                });
                
                transaction.update(txRef, {
                    status: 'completed',
                    verifiedBy: 'api_direct_check_success',
                    paidAt: new Date().toISOString()
                });
                return { finalStatus: 'success', message: 'Solde mis à jour avec succès' };
            } else if (interpretedStatus === 'failed') {
                transaction.update(txRef, { status: 'failed', verifiedBy: 'api_direct_check_failed' });
                return { finalStatus: 'failed', message: 'Paiement échoué ou annulé' };
            }
            return { finalStatus: 'pending', message: 'Toujours en attente' };
        });

        return res.status(200).json(result);
    } catch (error) {
        console.error('Erreur confirm-swychr:', error);
        return res.status(500).json({ error: error.message, finalStatus: 'pending' });
    }
});

// ---------------------------------------------------------
// 3. ROUTE : WEBHOOK AUTOMATIQUE (Asynchrone)
// ---------------------------------------------------------
app.post('/api/webhook-swychr', async (req, res) => {
    try {
        const payload = req.body;
        const attributes = payload?.data?.data?.attributes || payload?.data?.attributes || payload;
        if (!attributes) return res.status(400).send('Payload invalide');

        const { status, transaction_id } = attributes;
        const rawStatus = status ? String(status).toLowerCase().trim() : "inconnu";
        const statusSucces = ["success", "completed", "terminé", "succès", "reussi", "1", "successful", "paid", "ok"];

        if (statusSucces.includes(rawStatus)) { 
            const txRef = db.collection('transactions').doc(transaction_id);
            const txDoc = await txRef.get();

            if (txDoc.exists && txDoc.data().status === 'pending') {
                const { userId, amountXAF } = txDoc.data();
                
                // Utilisation de batch ou incrément direct
                await db.collection('users').doc(userId).update({
                    balance: admin.firestore.FieldValue.increment(Number(amountXAF))
                });

                await txRef.update({
                    status: 'completed',
                    paidAt: new Date().toISOString()
                });
                console.log(`Webhook Swychr: Transaction ${transaction_id} validée.`);
            }
        }
        return res.status(200).send('Webhook traité');
    } catch (error) {
        console.error('Erreur Webhook Swychr:', error);
        return res.status(500).send('Erreur interne');
    }
});


// ---------- EXPORT POUR VERCEL ----------
module.exports = app;