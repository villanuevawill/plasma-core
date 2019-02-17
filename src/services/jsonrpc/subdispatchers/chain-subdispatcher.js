const BaseSubdispatcher = require('./base-subdispatcher')

/**
 * Subdispatcher that handles chain-related requests.
 */
class ChainSubdispatcher extends BaseSubdispatcher {
  get prefix () {
    return 'pg_'
  }

  get dependencies () {
    return ['chain', 'chaindb']
  }

  get methods () {
    const chain = this.app.services.chain
    const chaindb = this.app.services.chaindb
    return {
      getBlockHeader: chaindb.getBlockHeader.bind(chaindb),
      getTransaction: chaindb.getTransaction.bind(chaindb),
      getLastSyncedBlock: chaindb.getLatestBlock.bind(chaindb),
      sendTransaction: chain.sendTransaction.bind(chain),
      sendMaliciousTransaction: chain.sendMaliciousTransaction.bind(chain),
      getMaliciousTransactions: chain.getMaliciousTransactions.bind(chain),
      pickRanges: chain.pickRanges.bind(chain),
      startExit: chain.startExit.bind(chain),
      finalizeExits: chain.finalizeExits.bind(chain),
      getExits: chain.getExitsWithStatus.bind(chain),
      getBalances: chain.getBalances.bind(chain)
    }
  }
}

module.exports = ChainSubdispatcher
