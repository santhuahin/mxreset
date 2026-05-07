require('dotenv').config()

const path = require('path')
const express = require('express')
const helmet = require('helmet')
const session = require('express-session')
const flash = require('connect-flash')

const resetRouter = require('./routes/reset')
const adminRouter = require('./routes/admin')

const app = express()
const PORT = process.env.PORT || 3000

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// Security headers — upgrade-insecure-requests is removed from CSP so the app
// works over plain HTTP behind a TLS-terminating reverse proxy (e.g. Caddy)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null,
    },
  },
}))

// View engine
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// Body parsers
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 2 * 60 * 60 * 1000, // 2 hours
  },
}))

// Flash messages
app.use(flash())

// Routes
app.use('/', resetRouter)
app.use('/admin', adminRouter)

// Global error handler — catches errors passed via next(err)
app.use((err, _req, res, _next) => {
  console.error('Express error:', err)
  res.status(500).send('Internal server error')
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
})

app.listen(PORT, () => {
  console.log(`mxreset listening on port ${PORT}`)
})
