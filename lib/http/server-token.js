'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { writePrivateJson } = require('../private-json');
const tokenFile = () =>
  process.env.SWIFT_TOKEN_FILE ||
  path.join(
    path.dirname(
      process.env.SWIFT_SETTINGS_FILE ||
        process.env.AGENT_STUDIO_SETTINGS_FILE ||
        path.resolve(__dirname, '../../.local/config/settings.json'),
    ),
    'direct-connection.json',
  );
function savedToken() {
  const file = tokenFile();
  if (!fs.existsSync(file)) return '';
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw Error('Swift token 文件权限无效。');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).token;
  if (typeof value !== 'string' || !value || value.length > 4096 || /[^!-~]/.test(value))
    throw Error('Swift token 文件无效。');
  return value;
}
function serverToken() {
  const saved = savedToken(),
    token =
      process.env.SWIFT_TOKEN ??
      process.env.AGENT_STUDIO_TOKEN ??
      (saved || crypto.randomBytes(32).toString('base64url'));
  if (token !== saved) writePrivateJson(tokenFile(), { token });
  return token;
}
module.exports = { serverToken, savedToken };
