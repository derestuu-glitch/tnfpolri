const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const midtransClient = require('midtrans-client');

const app = express();
app.use(cors());
app.use(express.json());

// Menyajikan berkas statis (jika ada css/js terpisah di folder public)
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// KONFIGURASI MIDTRANS & ENVIRONMENT
// ==========================================
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-YOUR_SANDBOX_SERVER_KEY';
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || 'SB-Mid-client-YOUR_SANDBOX_CLIENT_KEY';

// Mengubah string 'true' dari Vercel menjadi boolean true/false secara presisi
const IS_PRODUCTION = process.env.IS_PRODUCTION === 'true';

// Gunakan Snap jika Anda memanggil transaksi pop-up
const snap = new midtransClient.Snap({
  isProduction: IS_PRODUCTION,
  serverKey: MIDTRANS_SERVER_KEY,
  clientKey: MIDTRANS_CLIENT_KEY
});

const coreApi = new midtransClient.CoreApi({
  isProduction: IS_PRODUCTION,
  serverKey: MIDTRANS_SERVER_KEY,
  clientKey: MIDTRANS_CLIENT_KEY
});

// =========================================================================
// PAKET BERLANGGANAN & DATABASE IN-MEMORY
// =========================================================================
const SUBSCRIPTION_PLANS = {
    '7_days': { id: '7_days', name: '7 Hari', durationDays: 7, price: 15000 },
    '1_month': { id: '1_month', name: '1 Bulan', durationDays: 30, price: 35000 },
    '3_months': { id: '3_months', name: '3 Bulan', durationDays: 90, price: 75000 },
    '6_months': { id: '6_months', name: '6 Bulan', durationDays: 180, price: 120000 },
    '1_year': { id: '1_year', name: '1 Tahun', durationDays: 365, price: 199000 }
};

const users = [
    { id: 1, nama: 'Peserta Trial', email: 'trial@polri.com', password: 'password123', subscriptionUntil: null },
    { id: 2, nama: 'Peserta VIP', email: 'vip@polri.com', password: 'password123', subscriptionUntil: Date.now() + (30 * 24 * 60 * 60 * 1000) }
];

const transactions = new Map();
const practiceHistory = new Map();

function getUserStatus(user) {
    if (!user) return null;
    const now = Date.now();
    const isSubscribed = user.subscriptionUntil && user.subscriptionUntil > now;
    return {
        id: user.id,
        nama: user.nama,
        email: user.email,
        isSubscribed: !!isSubscribed,
        subscriptionUntil: user.subscriptionUntil
    };
}

function activateVipStatus(userEmail, durationDays) {
    const user = users.find(u => u.email.toLowerCase() === userEmail.toLowerCase());
    if (!user) return null;
    const now = Date.now();
    const durationMs = durationDays * 24 * 60 * 60 * 1000;
    user.subscriptionUntil = (user.subscriptionUntil && user.subscriptionUntil > now)
        ? user.subscriptionUntil + durationMs
        : now + durationMs;
    return user;
}

// =========================================================================
// API ENDPOINTS
// =========================================================================

app.post('/api/register', (req, res) => {
    const { nama, email, password } = req.body;
    if (!nama || !email || !password) return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi!' });
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Email sudah terdaftar!' });
    }
    const newUser = { id: users.length + 1, nama, email, password, subscriptionUntil: null };
    users.push(newUser);
    res.json({ success: true, message: 'Pendaftaran berhasil! Silakan login.', user: getUserStatus(newUser) });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase() && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Email atau kata sandi salah!' });
    res.json({ success: true, message: 'Login berhasil!', user: getUserStatus(user) });
});

app.post('/api/forgot-password', (req, res) => {
    const { email, newPassword } = req.body;
    const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
    if (!user) return res.status(404).json({ success: false, message: 'Email tidak ditemukan!' });
    user.password = newPassword;
    res.json({ success: true, message: 'Kata sandi berhasil diperbarui!' });
});

app.get('/api/user-status', (req, res) => {
    const user = users.find(u => u.email.toLowerCase() === req.query.email?.toLowerCase());
    if (!user) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    res.json({ success: true, user: getUserStatus(user) });
});

app.post('/api/save-practice-history', (req, res) => {
    const { email, historyData } = req.body;
    const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
    if (!user) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });

    const key = email.toLowerCase();
    if (!practiceHistory.has(key)) practiceHistory.set(key, []);

    const newRecord = {
        id: `HIS-${Date.now()}`,
        timestamp: Date.now(),
        dateFormatted: new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
        category: historyData.category,
        totalColumns: historyData.totalColumns,
        itemCountPerCol: historyData.itemCountPerCol,
        summary: historyData.summary,
        speedMetrics: historyData.speedMetrics,
        tradeOffCategory: historyData.tradeOffCategory
    };

    practiceHistory.get(key).unshift(newRecord);
    res.json({ success: true, message: 'Riwayat latihan disimpan!', record: newRecord });
});

app.get('/api/user-history', (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ success: false, message: 'Email diperlukan.' });
    const history = practiceHistory.get(email.toLowerCase()) || [];
    res.json({ success: true, history });
});

app.post('/api/create-qris-payment', async (req, res) => {
    try {
        const { email, planId } = req.body;
        const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
        if (!user) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });

        const plan = SUBSCRIPTION_PLANS[planId];
        if (!plan) return res.status(400).json({ success: false, message: 'Paket tidak valid.' });

        const orderId = `CAT-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

        let qrisImageUrl = '';
        if (MIDTRANS_SERVER_KEY.includes('YOUR_SANDBOX_SERVER_KEY')) {
            qrisImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=00020101021226580014ID.LINKAJA.WWW011893600911000300010203040303UMI51440014ID.INDOMARET011893600911000300010203040303UMI5204599953033605802ID5913CAT_POLRI_VIP6007JAKARTA61051234062070703A016304`;
        } else {
            const chargeResponse = await coreApi.charge({
                payment_type: 'qris',
                transaction_details: { order_id: orderId, gross_amount: plan.price },
                item_details: [{ id: plan.id, price: plan.price, quantity: 1, name: `VIP CAT Polri (${plan.name})` }],
                customer_details: { first_name: user.nama, email: user.email },
                qris: { acquirer: 'gopay' }
            });
            const qrAction = chargeResponse.actions?.find(a => a.name === 'generate-qr-code');
            if (qrAction) qrisImageUrl = qrAction.url;
        }

        transactions.set(orderId, {
            orderId, userEmail: user.email, planId: plan.id, durationDays: plan.durationDays,
            amount: plan.price, status: 'pending', createdAt: Date.now()
        });

        res.json({
            success: true,
            transaction: { orderId, planId: plan.id, planName: plan.name, durationDays: plan.durationDays, amount: plan.price, qrisImageUrl }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal membuat transaksi: ' + error.message });
    }
});

app.get('/api/check-payment-status', (req, res) => {
    const tx = transactions.get(req.query.orderId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' });
    const user = users.find(u => u.email.toLowerCase() === tx.userEmail.toLowerCase());
    res.json({ success: true, orderId: tx.orderId, status: tx.status, isSettlement: tx.status === 'settlement', user: user ? getUserStatus(user) : null });
});

app.post('/api/simulasi-pembayaran-sukses', (req, res) => {
    const tx = transactions.get(req.body.orderId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' });
    tx.status = 'settlement';
    const updatedUser = activateVipStatus(tx.userEmail, tx.durationDays);
    res.json({ success: true, message: 'Simulasi Pembayaran Berhasil! Status akun aktif VIP.', user: getUserStatus(updatedUser) });
});

// =========================================================================
// RENDER FRONTEND KODE HTML
// =========================================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));