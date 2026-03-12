const express = require('express')
const crypto = require('crypto')
const nodemailer = require('nodemailer')
const rateLimit = require('express-rate-limit')
const prisma = require('../db')
const { decrypt } = require('../services/crypto')
const { updatePassword } = require('../services/mxroute')

const router = express.Router()

// In-memory per-email rate limit: max 3 requests per hour
const emailRateStore = new Map()
const EMAIL_RATE_LIMIT = 3
const EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

function checkEmailRateLimit(email) {
  const now = Date.now()
  const entry = emailRateStore.get(email)

  if (!entry || now - entry.firstRequest > EMAIL_RATE_WINDOW_MS) {
    emailRateStore.set(email, { count: 1, firstRequest: now })
    return true
  }

  if (entry.count >= EMAIL_RATE_LIMIT) {
    return false
  }

  entry.count++
  return true
}

// IP-level rate limit on the reset request endpoint
const ipRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
})

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// GET / — reset request form
router.get('/', (req, res) => {
  res.render('index', { title: 'Password Reset' })
})

// POST /reset/request — initiate reset
router.post('/reset/request', ipRateLimit, async (req, res) => {
  const GENERIC_MESSAGE = 'If this address is registered, a reset link has been sent to your recovery email.'

  const email = (req.body.email || '').trim().toLowerCase()

  if (!email || !isValidEmail(email)) {
    return res.render('index', { title: 'Password Reset', message: GENERIC_MESSAGE })
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } })

    if (user) {
      // Check per-email rate limit
      if (!checkEmailRateLimit(email)) {
        return res.render('index', { title: 'Password Reset', message: GENERIC_MESSAGE })
      }

      // Delete any existing unused tokens for this user
      await prisma.resetToken.deleteMany({
        where: { userId: user.id, used: false },
      })

      // Generate token
      const rawToken = crypto.randomBytes(32).toString('hex')
      const tokenHash = hashToken(rawToken)
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

      await prisma.resetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      })

      // Decrypt recovery email and send
      const recoveryEmail = decrypt(user.recoveryEmail)
      const resetLink = `${process.env.BASE_URL}/reset/${rawToken}`

      const transporter = createTransporter()
      await transporter.sendMail({
        from: "MXReset",
        to: recoveryEmail,
        subject: 'Password Reset Request',
        text: `You requested a password reset for ${email}.\n\nClick the link below to reset your password (valid for 15 minutes):\n\n${resetLink}\n\nIf you did not request this, you can safely ignore this email.`,
        html: `<p>You requested a password reset for <strong>${email}</strong>.</p><p><a href="${resetLink}">Reset your password</a> (valid for 15 minutes)</p><p>If you did not request this, you can safely ignore this email.</p><br><p>MXReset</p>`,
      })
    }
  } catch (err) {
    // Silently swallow errors to avoid leaking information
    console.error('Reset request error:', err.message)
  }

  res.render('index', { title: 'Password Reset', message: GENERIC_MESSAGE })
})

// GET /reset/:token — render password reset form
router.get('/reset/:token', async (req, res) => {
  const { token } = req.params
  const tokenHash = hashToken(token)

  try {
    const record = await prisma.resetToken.findFirst({
      where: {
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
    })

    if (!record) {
      return res.render('reset-result', {
        title: 'Invalid Reset Link',
        success: false,
        message: 'This reset link is invalid or has expired. Please request a new one.',
      })
    }

    res.render('reset-form', { title: 'Set New Password', token, error: null })
  } catch (err) {
    console.error('Token validation error:', err.message)
    res.render('reset-result', {
      title: 'Error',
      success: false,
      message: 'An error occurred. Please try again.',
    })
  }
})

// POST /reset/:token — submit new password
router.post('/reset/:token', async (req, res) => {
  const { token } = req.params
  const tokenHash = hashToken(token)
  const { password, confirmPassword } = req.body

  // Re-validate token
  let record
  try {
    record = await prisma.resetToken.findFirst({
      where: {
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    })
  } catch (err) {
    console.error('Token lookup error:', err.message)
    return res.render('reset-result', {
      title: 'Error',
      success: false,
      message: 'An error occurred. Please try again.',
    })
  }

  if (!record) {
    return res.render('reset-result', {
      title: 'Invalid Reset Link',
      success: false,
      message: 'This reset link is invalid or has expired. Please request a new one.',
    })
  }

  // Validate password
  if (!password || password.length < 8) {
    return res.render('reset-form', {
      title: 'Reset Password',
      token,
      error: 'Password must be at least 8 characters.',
    })
  }

  if (password !== confirmPassword) {
    return res.render('reset-form', {
      title: 'Reset Password',
      token,
      error: 'Passwords do not match.',
    })
  }

  try {
    await updatePassword(record.user.email, password)

    await prisma.resetToken.update({
      where: { id: record.id },
      data: { used: true },
    })

    res.render('reset-result', {
      title: 'Password Updated',
      success: true,
      message: 'Your password has been updated successfully. You can now log in with your new password.',
    })
  } catch (err) {
    console.error('Password update error:', err.message)
    res.render('reset-result', {
      title: 'Error',
      success: false,
      message: 'Failed to update your password. Please try again or contact support.',
    })
  }
})

module.exports = router