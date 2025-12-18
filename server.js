// =============================================================
// SERVER FARMASI (SALMA) - PORT 3000
// FINAL FIXED VERSION: SESUAI KOLOM CSV DATABASE
// =============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid'); 

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// --- [REVISI 2: TAMBAHAN UNTUK MENGATASI ERROR SSL/CERTIFICATE] ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { 
        rejectUnauthorized: false 
    }
});

// FUNGSI BANTUAN: HITUNG HARGA JUAL
function calculateSellingPrice(drug) {
    const hna = parseFloat(drug.hna_price) || 0;
    const margin = parseFloat(drug.margin_percentage) || 0;
    const tax = parseFloat(drug.tax_rate) || 0;

    const priceAfterMargin = hna + (hna * (margin / 100));
    const taxAmount = priceAfterMargin * (tax / 100);
    return Math.ceil(priceAfterMargin + taxAmount);
}

// --- TAMBAHAN UNTUK MENGATASI "Cannot GET /" ---
app.get('/', (req, res) => {
    res.send('✅ SERVER FARMASI (SALMA) READY DI PORT 3000');
});
// ------------------------------------------------------------

// Cek Koneksi
pool.connect((err) => {
    if (err) console.error('❌ Gagal konek DB:', err.message);
    else console.log('✅ SERVER FARMASI READY & TERHUBUNG KE SUPABASE (Data Obat Terkalibrasi)');
});

// =============================================================
// 1. API LIST OBAT (Disesuaikan endpointnya jadi /api/drugs-list agar cocok dengan frontend umumnya)
// =============================================================
app.get('/api/drugs-list', async (req, res) => {
try {
        console.log("📥 Mengambil data obat dari tabel medicines...");
        
        // Query langsung ke tabel medicines
        const result = await pool.query('SELECT * FROM medicines ORDER BY name ASC');
        
        console.log(`✅ Berhasil ambil ${result.rows.length} obat.`);

        const medicinesWithPrice = result.rows.map(obat => ({
            id: obat.id,
            name: obat.name,
            stock: parseInt(obat.stock),
            price: calculateSellingPrice(obat) // Hitung atau ambil harga
        }));
        res.json({ status: 'success', data: medicinesWithPrice });
    } catch (err) {
        console.error("❌ Error query medicines:", err.message);
        // Fallback error message yang jelas
        res.status(500).json({ 
            status: 'error', 
            message: `Gagal ambil data. Pastikan tabel 'medicines' ada. Error: ${err.message}` 
        });
    }
});

// 2. API LIST PASIEN
app.get('/api/patients-list', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, mr_no FROM patients ORDER BY full_name ASC');
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).send('Error ambil pasien');
    }
});

// =============================================================
// API 3: INPUT RESEP (FINAL FIX: DEFINISI ITEMCODE)
// =============================================================
app.post('/api/submit-prescription', async (req, res) => {
    const { items, doctor_id, patient_id } = req.body; 
    
    if (!items || items.length === 0) return res.status(400).json({ message: 'Keranjang kosong!' });
    if (!patient_id) return res.status(400).json({ message: 'Pilih pasien dulu!' });

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const prescriptionId = uuidv4();
        const invoiceId = uuidv4();

// A. Insert Prescription Header
        await client.query(
            `INSERT INTO prescriptions (id, patient_id, doctor_id, status, created_at) 
             VALUES ($1, $2, $3, 'processed', NOW())`,
            [prescriptionId, patient_id, doctor_id] 
        );

        // B. Insert Invoice Header DULUAN (Total 0 dulu, biar ID-nya ada)
        // [SOLUSI ERROR FOREIGN KEY ADA DISINI]
        await client.query(
            `INSERT INTO invoices (id, patient_id, total_amount, status, created_at)
             VALUES ($1, $2, 0, 'unpaid', NOW())`,
            [invoiceId, patient_id]
        );

        let grandTotal = 0;
        
for (const item of items) {
            const drugId = item.drug_id || item.id;
            const drugRes = await client.query('SELECT * FROM medicines WHERE id = $1', [drugId]);

            if (drugRes.rows.length === 0) throw new Error(`Obat ID ${drugId} invalid.`);
            
            const drug = drugRes.rows[0];
            const finalPrice = calculateSellingPrice(drug);
            const qty = parseInt(item.qty) || 1;
            const itemCode = drug.kfa_code || 'GENERIC';            // -----------------------------------------------

            const subtotal = finalPrice * qty; 
            grandTotal += subtotal;

            // Masuk Detail Resep
            await client.query(
                `INSERT INTO prescription_details (id, prescription_id, medicine_id, qty, dosage_instruction, price_snapshot) 
                 VALUES ($1, $2, $3, $4, '1x1 Sesuai Anjuran', $5)`,
                [uuidv4(), prescriptionId, drugId, qty, finalPrice] 
            );

            // Masuk Detail Invoice
            await client.query(
                `INSERT INTO invoice_details (id, invoice_id, item_code, item_name, item_type, qty, price)
                 VALUES ($1, $2, $3, $4, 'drug', $5, $6)`,
                [uuidv4(), invoiceId, itemCode, drug.name, qty, finalPrice]
            );
        }

        // D. Update Total Invoice Terakhir
        await client.query(
            `UPDATE invoices SET total_amount = $1 WHERE id = $2`,
            [grandTotal, invoiceId]
        );

        await client.query('COMMIT');
        console.log(`✅ Resep Sukses! Total: Rp${grandTotal}`);

        res.json({
            status: 'success',
            message: 'Resep berhasil dikirim!',
            invoice_id: invoiceId
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Gagal Submit:", err.message);
        res.status(500).json({ status: 'error', message: err.message });
    } finally {
        client.release();
    }
});

// 4. API SEARCH BILL (KASIR)
app.get('/api/cashier/search-bill', async (req, res) => {
    const { keyword } = req.query; 
    if (!keyword) return res.status(400).json({ message: "Ketik nama pasien." });

    try {
        const query = `
            SELECT id, patient_id, total_amount, status, created_at 
            FROM invoices 
            WHERE status = 'unpaid' 
            ORDER BY created_at DESC
        `;        
        const result = await pool.query(query);
        res.json({ status: 'success', data: result.rows });        
        
        const cleanData = result.rows.map(row => ({
            ...row,
            total_amount: Number(row.raw_total_amount) || 0 
        }));
        
        if (cleanData.length > 0) res.json({ status: 'success', data: cleanData });
        else res.json({ status: 'not_found', message: 'Tidak ada tagihan.', data: [] });

    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// 5. API BILL DETAILS
app.get('/api/cashier/bill-details/:prescriptionId', async (req, res) => {
    const { prescriptionId } = req.params;
    try {
        const query = `
            SELECT m.name AS drug_name, pd.qty, pd.price_snapshot AS price, pd.subtotal
            FROM prescription_details pd
            JOIN medicines m ON pd.medicine_id = m.id
        `;
        const result = await pool.query(query, [prescriptionId]);
        const total = result.rows.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
        res.json({ status: 'success', data: result.rows, grand_total: total });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// =============================================================
// API 6: LIST DOKTER
// =============================================================
app.get('/api/doctors-list', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, specialization FROM doctors WHERE is_active = true ORDER BY name ASC");
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error ambil dokter');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server Farmasi (Port ${PORT}) running...`);
});