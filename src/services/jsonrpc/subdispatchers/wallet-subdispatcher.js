const BaseSubdispatcher = require('./base-subdispatcher')

/**
 * Subdispatcher that handles wallet-related requests.
 */
class WalletSubdispatcher extends BaseSubdispatcher {
  get prefix () {
    return 'pg_'
  }

  get dependencies () {
    return ['wallet']
  }

  get methods () {
    const wallet = this.app.services.wallet
    return {
      getAccounts: wallet.getAccounts.bind(wallet),
      sign: wallet.sign.bind(wallet),
      maliciousSign: wallet.maliciousSign.bind(wallet),
      createAccount: wallet.createAccount.bind(wallet),
      monitorAccount: wallet.monitorAccount.bind(wallet)
    }
  }
}

module.exports = WalletSubdispatcher
