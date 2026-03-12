// function to check admin session does exist before proceeding with the request

module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.admin === true) {
    return next()
  }
  res.redirect('/admin/login')
}