const BaseService = require('../base-service')

/**
 * Handles sync-related DB calls.
 */
class SyncDB extends BaseService {
  get name () {
    return 'syncdb'
  }

  get dependencies () {
    return ['db']
  }

  /**
   * Returns the last synced block.
   * @return {number} Last synced block number.
   */
  async getLastSyncedBlock () {
    return this.services.db.get('sync:block', -1)
  }

  /**
   * Sets the last synced block number.
   * @param {number} block Block number to set.
   */
  async setLastSyncedBlock (block) {
    await this.services.db.set('sync:block', block)
  }

  /**
   * Returns transactions that failed to sync.
   * @return {Array<string>} An array of encoded transactions.
   */
  async getFailedTransactions () {
    return this.services.db.get('sync:failed', [])
  }


  /**
   * Sets malicious transactions.
   * @param {<string>} an error string
   */
  async setMaliciousTransaction (address, message, hash) {
    const rawMalicious = await this.services.db.get(`sync:malicious:${address}`, '{}')
    const currentMalicious = JSON.parse(rawMalicious)
    currentMalicious[hash] = message
    return this.services.db.set(`sync:malicious:${address}`, JSON.stringify(currentMalicious))
  }


  /**
   * Returns malicious transaction for address.
   * @return {<string>} malicious transaction
   */
  async getMaliciousTransactions (address) {
    return this.services.db.get(`sync:malicious:${address}`, '{}')
  }

  /**
   * Sets the failed transactions.
   * @param {Array<string>} transactions An array of encoded transactions.
   */
  async setFailedTransactions (transactions) {
    await this.services.db.set('sync:failed', transactions)
  }
}

module.exports = SyncDB
