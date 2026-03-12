const https = require('https')

/**
 * Updates the password for a given email address via the MXRoute API.
 * PATCH https://api.mxroute.com/domains/{domain}/email-accounts/{user}
 *
 * @param {string} email - The MXRoute custom domain email address (e.g. hassan@example.com)
 * @param {string} newPassword - The new password to set
 * @returns {Promise<void>}
**/

async function updatePassword(email, newPassword) {
  const apiKey   = process.env.MXROUTE_API_KEY
  const server   = process.env.MXROUTE_SERVER
  const username = process.env.MXROUTE_USERNAME

  if (!apiKey || !server || !username) {
    throw new Error('MXROUTE_API_KEY, MXROUTE_SERVER, and MXROUTE_USERNAME must be set')
  }

  const [user, domain] = email.split('@')
  if (!user || !domain) {
    throw new Error(`Invalid email address: ${email}`)
  }

  const payload = JSON.stringify({ password: newPassword })

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mxroute.com',
      path: `/domains/${encodeURIComponent(domain)}/email-accounts/${encodeURIComponent(user)}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Server': server,
        'X-Username': username,
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          try {
            const body = JSON.parse(data)
            reject(new Error(`MXRoute API error: ${body.error?.message || data}`))
          } catch {
            reject(new Error(`MXRoute API error: HTTP ${res.statusCode}`))
          }
        }
      })
    })

    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

module.exports = { updatePassword }