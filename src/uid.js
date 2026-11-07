// the short public id shown with messages: stable per person, can't be turned back into their real id
const crypto = require('crypto');
const { JWT_SECRET } = require('./auth');

const uidFor = (userId) => crypto.createHmac('sha256', JWT_SECRET).update('uid:' + userId).digest('hex').slice(0, 10);

module.exports = { uidFor };
