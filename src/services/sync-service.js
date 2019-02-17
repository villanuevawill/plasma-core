const BaseService = require('./base-service')

const utils = require('plasma-utils')
const SignedTransaction = utils.serialization.models.SignedTransaction

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'

const defaultOptions = {
  transactionPollInterval: 15000
}

/**
 * Handles automatically synchronizing latest history proofs.
 */
class SyncService extends BaseService {
  constructor (options) {
    super(options, defaultOptions)
    this.pending = []
  }

  get name () {
    return 'sync'
  }

  get dependencies () {
    return [
      'contract',
      'chain',
      'eventHandler',
      'syncdb',
      'chaindb',
      'wallet',
      'operator'
    ]
  }

  async _onStart () {
    this.services.eventHandler.on('event:Deposit', this._onDeposit.bind(this))
    this.services.eventHandler.on(
      'event:BlockSubmitted',
      this._onBlockSubmitted.bind(this)
    )
    this.services.eventHandler.on(
      'event:ExitStarted',
      this._onExitStarted.bind(this)
    )
    this.services.eventHandler.on(
      'event:ExitFinalized',
      this._onExitFinalized.bind(this)
    )

    this._pollPendingTransactions()
  }

  async _onStop () {
    this.removeAllListeners()
  }

  /**
   * Wrapper that handles regularly polling pending transactions.
   */
  async _pollPendingTransactions () {
    if (!this.started) return

    try {
      await this._checkPendingTransactions()
    } finally {
      await utils.utils.sleep(this.options.transactionPollInterval)
      this._pollPendingTransactions()
    }
  }

  /**
   * Checks for any available pending transactions and emits an event for each.
   */
  async _checkPendingTransactions () {
    if (!this.services.operator.online || !this.services.contract.hasAddress) {
      return
    }

    const lastSyncedBlock = await this.services.syncdb.getLastSyncedBlock()
    const firstUnsyncedBlock = lastSyncedBlock + 1
    const currentBlock = await this.services.chaindb.getLatestBlock()
    const prevFailed = await this.services.syncdb.getFailedTransactions()
    const addresses = await this.services.wallet.getAccounts()

    if (firstUnsyncedBlock <= currentBlock) {
      this.logger(
        `Checking for new transactions between plasma blocks ${firstUnsyncedBlock} and ${currentBlock}`
      )
    } else if (prevFailed.length > 0) {
      this.logger(`Attempting to apply failed transactions`)
    } else {
      return
    }

    // TODO: Figure out how handle operator errors.
    for (let address of addresses) {
      const received = await this.services.operator.getTransactions(
        address,
        firstUnsyncedBlock,
        currentBlock
      )
      if (received.length || received[0]) {
        this.pending = this.pending.concat({received: received, address: address})
      }
    }

    // Add any previously failed transactions to try again.
    this.pending = this.pending.concat(prevFailed)

    // Remove any duplicates
    this.pending = [...new Set(this.pending)]

    let failed = []
    for (let i = 0; i < this.pending.length; i++) {
      const encoded = this.pending[i].received
      const address = this.pending[i].address
      const tx = new SignedTransaction(encoded)

      // Make sure we're not importing transactions we don't have blocks for.
      // Necessary because of a bug in the operator.
      // TODO: Fix operator so this isn't necessary.
      if (tx.block.gtn(currentBlock)) {
        continue
      }

      try {
        await this._addTransaction(tx)
      } catch (err) {
        failed.push(encoded)
        if (err.message.includes('Invalid transaction proof')) {
          this.services.syncdb.setMaliciousTransaction(address, err.message, tx.hash)
        }
        this.logger(`ERROR: ${err}`)
        this.logger(
          `Ran into an error while importing transaction: ${
            tx.hash
          }, trying again in a few seconds...`
        )
      }
    }

    await this.services.syncdb.setFailedTransactions(failed)
    await this.services.syncdb.setLastSyncedBlock(currentBlock)
  }

  /**
   * Tries to add any newly received transactions.
   * @param {*} encoded An encoded transaction.
   */
  async _addTransaction (tx) {
    // TODO: The operator should really be avoiding this.
    if (
      tx.transfers[0].sender === NULL_ADDRESS ||
      (await this.services.chaindb.hasTransaction(tx.hash))
    ) {
      return
    }

    this.logger(`Detected new transaction: ${tx.hash}`)
    this.logger(`Attemping to pull information for transaction: ${tx.hash}`)
    let txInfo
    try {
      txInfo = await this.services.operator.getTransaction(tx.encoded)
    } catch (err) {
      this.logger(
        `ERROR: Operator failed to return information for transaction: ${
          tx.hash
        }`
      )
      throw err
    }

    this.logger(`Importing new transaction: ${tx.hash}`)
    await this.services.chain.addTransaction(
      txInfo.transaction,
      txInfo.deposits,
      txInfo.proof
    )
    this.logger(`Successfully imported transaction: ${tx.hash}`)
  }

  /**
   * Handles new deposit events.
   * @param {Array<DepositEvent>} deposits Deposit events.
   */
  async _onDeposit (deposits) {
    await this.services.chain.addDeposits(deposits)
  }

  /**
   * Handles new block events.
   * @param {Array<BlockSubmittedEvent>} blocks Block submission events.
   */
  async _onBlockSubmitted (blocks) {
    await this.services.chaindb.addBlockHeaders(blocks)
  }

  /**
   * Handles new exit started events.
   * @param {Array<ExitStartedEvent>} exits Exit started events.
   */
  async _onExitStarted (exits) {
    for (let exit of exits) {
      await this.services.chain.addExit(exit)
    }
  }

  /**
   * Handles new exit finalized events.
   * @param {Array<ExitFinalizedEvent>} exits Exit finalized events.
   */
  async _onExitFinalized (exits) {
    for (let exit of exits) {
      await this.services.chaindb.markFinalized(exit)
      await this.services.chaindb.addExitableEnd(exit.token, exit.start)
    }
  }
}

module.exports = SyncService
