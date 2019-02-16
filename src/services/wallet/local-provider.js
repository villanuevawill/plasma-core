const BaseWalletProvider = require('./base-provider')

class LocalWalletProvider extends BaseWalletProvider {
  get dependencies () {
    return ['web3', 'db']
  }

  async getAccounts () {
    const accounts = await this.services.db.get('accounts', [])
    return accounts
  }

  async sign (address, data) {
    const account = await this._getAccount(address)
    return account.sign(data)
  }

  async createAccount () {
    // TODO: Support encrypted accounts.
    const account = this.services.web3.eth.accounts.create()

    const accounts = await this.getAccounts()
    accounts.push(account.address)
    await this.services.db.set('accounts', accounts)

    await this.services.db.set(`keystore:${account.address}`, account)
    await this.addAccountToWallet(account.address)
    return account.address
  }

  /**
   * Adds an account to the web3 wallet so that it can send contract transactions directly.
   * See https://bit.ly/2MPAbRd for more information.
   * @param {string} address Address of the account to add to wallet.
   */
  async addAccountToWallet (address) {
    const accounts = await this.services.web3.eth.accounts.wallet
    if (address in accounts) return

    const account = await this._getAccount(address)
    await this.services.web3.eth.accounts.wallet.add(account.privateKey)
  }

  /**
   * Part of a POC - gives node ability to just monitor an account
   * @param {string} address Address of the account to monitort.
   */
  async monitorAccount (address) {
    const accounts = await this.getAccounts()
    console.log('address: ', address)
    accounts.push(address)
    await this.services.db.set('accounts', accounts)
  }

  /**
   * Returns an account object for a given address.
   * @param {string} address Adress of the account.
   * @return {*} A Web3 account object.
   */
  async _getAccount (address) {
    const keystore = await this.services.db.get(`keystore:${address}`, null)
    if (!keystore) {
      throw new Error('Account not found')
    }

    return this.services.web3.eth.accounts.privateKeyToAccount(
      keystore.privateKey
    )
  }
}

module.exports = LocalWalletProvider
