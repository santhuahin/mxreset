const express = require('express')
const bcrypt = require('bcrypt')
const multer = require('multer')
const { parse } = require('csv-parse')
const prisma = require('../db')
const { encrypt, decrypt } = require('../services/crypto')
const requireAdmin = require('../middleware/auth')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })

// In-memory IP lockout store for login attempts
// Map<ip, { count: number, lockedUntil: number | null }>
const loginAttempts = new Map()
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || 'unknown'
}

function isLockedOut(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry) return false
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginAttempts.delete(ip)
    return false
  }
  return false
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
  }
  loginAttempts.set(ip, entry)
}

function clearAttempts(ip) {
  loginAttempts.delete(ip)
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function maskEmail(encryptedEmail) {
  try {
    const plain = decrypt(encryptedEmail)
    const [local, domain] = plain.split('@')
    if (!domain) return '***'
    const masked = local.length > 2
      ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1]
      : '***'
    return `${masked}@${domain}`
  } catch {
    return '***'
  }
}

// GET /admin/login
router.get('/login', (req, res) => {
  res.render('admin/login', {
    title: 'Admin Login',
    error: req.flash('error')[0] || null,
  })
})

// POST /admin/login
router.post('/login', async (req, res) => {
  const ip = getClientIp(req)
  console.log("REQUEST")
  if (isLockedOut(ip)) {
    req.flash('error', 'Too many failed attempts. Please try again later.')
    return res.redirect('/admin/login')
  }

  const { password } = req.body

  try {
    const hash = process.env.ADMIN_PASSWORD_HASH
    const match = hash && password ? await bcrypt.compare(password, hash) : false

    if (match) {
      clearAttempts(ip)
      req.session.admin = true
      console.log("error")
      return res.redirect('/admin')
    }
  } catch (err) {
    console.log("error")
    console.error('Login error:', err.message)
  }

  recordFailedAttempt(ip)
  console.log("error")
  req.flash('error', 'Invalid credentials.')
  res.redirect('/admin/login')
})

// GET /admin/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login')
  })
})

// GET /admin — dashboard
router.get('/', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
    const usersWithMasked = users.map((u) => ({
      ...u,
      maskedRecoveryEmail: maskEmail(u.recoveryEmail),
    }))

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      users: usersWithMasked,
      flash: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null,
      },
      importSummary: null,
    })
  } catch (err) {
    console.error('Dashboard error:', err.message)
    res.status(500).send('Internal server error')
  }
})

// POST /admin/users — add single user
router.post('/users', requireAdmin, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase()
  const recoveryEmail = (req.body.recoveryEmail || '').trim().toLowerCase()

  if (!isValidEmail(email) || !isValidEmail(recoveryEmail)) {
    req.flash('error', 'Both email addresses must be valid.')
    return res.redirect('/admin')
  }

  try {
    const encryptedRecovery = encrypt(recoveryEmail)
    await prisma.user.create({ data: { email, recoveryEmail: encryptedRecovery } })
    req.flash('success', `User ${email} added successfully.`)
  } catch (err) {
    if (err.code === 'P2002') {
      req.flash('error', `Email ${email} already exists.`)
    } else {
      console.error('Add user error:', err.message)
      req.flash('error', 'Failed to add user.')
    }
  }

  res.redirect('/admin')
})

// POST /admin/users/import — CSV bulk import
router.post('/users/import', requireAdmin, upload.single('csvFile'), async (req, res) => {
  let imported = 0
  let skipped = 0
  const failed = []

  const renderWithSummary = async (importSummary) => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
    const usersWithMasked = users.map((u) => ({
      ...u,
      maskedRecoveryEmail: maskEmail(u.recoveryEmail),
    }))
    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      users: usersWithMasked,
      flash: { success: null, error: null },
      importSummary,
    })
  }

  if (!req.file) {
    return renderWithSummary({ imported: 0, skipped: 0, failed: [{ row: 'N/A', reason: 'No file uploaded.' }] })
  }

  const csvBuffer = req.file.buffer.toString('utf8')

  let records
  try {
    records = await new Promise((resolve, reject) => {
      parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true }, (err, data) => {
        if (err) return reject(err)
        resolve(data)
      })
    })
  } catch (err) {
    return renderWithSummary({ imported: 0, skipped: 0, failed: [{ row: 'CSV', reason: 'Failed to parse CSV file.' }] })
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const rowNum = i + 2 // account for header row
    const email = (record.email || '').trim().toLowerCase()
    const recoveryEmail = (record.recoveryEmail || '').trim().toLowerCase()

    if (!isValidEmail(email)) {
      failed.push({ row: rowNum, reason: `Invalid email: "${record.email || ''}"` })
      continue
    }

    if (!isValidEmail(recoveryEmail)) {
      failed.push({ row: rowNum, reason: `Invalid recovery email: "${record.recoveryEmail || ''}"` })
      continue
    }

    try {
      const encryptedRecovery = encrypt(recoveryEmail)
      await prisma.user.create({ data: { email, recoveryEmail: encryptedRecovery } })
      imported++
    } catch (err) {
      if (err.code === 'P2002') {
        skipped++
      } else {
        console.error(`Import row ${rowNum} error:`, err.message)
        failed.push({ row: rowNum, reason: 'Database error.' })
      }
    }
  }

  renderWithSummary({ imported, skipped, failed })
})

// POST /admin/users/:id/delete — remove user
router.post('/users/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10)

  if (isNaN(id)) {
    req.flash('error', 'Invalid user ID.')
    return res.redirect('/admin')
  }

  try {
    await prisma.user.delete({ where: { id } })
    req.flash('success', 'User deleted.')
  } catch (err) {
    console.error('Delete user error:', err.message)
    req.flash('error', 'Failed to delete user.')
  }

  res.redirect('/admin')
})

module.exports = router