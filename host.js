'use strict';

/**
 * @file Maakt van een ingetypt adres een kale hostnaam of IP-adres.
 * "http://10.0.28.152/" of "10.0.28.152:5200" wordt "10.0.28.152" (poort staat in een apart veld).
 */

/**
 * @param {any} v ingetypte waarde
 * @returns {string} host zonder protocol, pad of poort
 */
function cleanHost(v) {
  return String(v ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
}

module.exports = { cleanHost };
