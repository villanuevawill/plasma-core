const BigNum = require('bn.js')
const AsyncLock = require('async-lock')
const utils = require('plasma-utils')
const models = utils.serialization.models
const SignedTransaction = models.SignedTransaction

const BaseService = require('../base-service')
const SnapshotManager = require('./snapshot-manager')

/**
 * Manages the local blockchain.
 */
class ChainService extends BaseService {
  constructor (options) {
    super(options)
    this.lock = new AsyncLock()
  }

  get name () {
    return 'chain'
  }

  get dependencies () {
    return ['web3', 'contract', 'operator', 'chaindb', 'proof']
  }

  /**
   * Returns the balances of an account.
   * @param {string} address Address of the account to query.
   * @return {*} A list of tokens and balances.
   */
  async getBalances (address) {
    const stateManager = await this.loadState()
    const ranges = stateManager.getOwnedRanges(address)

    let balances = {}
    for (let range of ranges) {
      // Set the balance of this token to zero if it hasn't been seen yet.
      if (!(range.token in balances)) {
        balances[range.token] = new BigNum(0)
      }

      // Add the size of this range.
      balances[range.token] = balances[range.token].add(
        range.end.sub(range.start)
      )
    }

    return balances
  }

  /**
   * Adds deposit records to the database.
   * @param {Array<Deposit>} deposits Deposits to add.
   */
  async addDeposits (deposits) {
    // Filter out any ranges that have already been exited.
    const isNotExited = await Promise.all(
      deposits.map(async (deposit) => {
        return !(await this.services.chaindb.checkExited(deposit))
      })
    )
    deposits = deposits.filter((_, i) => isNotExited[i])

    // Add the deposit to the head state.
    await this.lock.acquire('state', async () => {
      const stateManager = await this.loadState()
      for (const deposit of deposits) {
        stateManager.applyDeposit(deposit)
      }
      await this.saveState(stateManager)
    })

    await this.services.chaindb.addExitableEnds(deposits)

    for (const deposit of deposits) {
      this.logger(
        `Added deposit to database: ${deposit.owner}, ${deposit.amount}, [${
          deposit.token
        }]`
      )
    }
  }

  /**
   * Returns the list of known exits for an address
   * along with its status (challenge period completed, exit finalized).
   * This method makes contract calls and is therefore slower than `getExits`.
   * @param {string} address Address to query.
   * @return {Array<Exit>} List of known exits.
   */
  async getExitsWithStatus (address) {
    const exits = await this.services.chaindb.getExits(address)

    const currentBlock = await this.services.web3.eth.getBlockNumber()
    // const challengePeriod = await this.services.contract.getChallengePeriod()
    const challengePeriod = 20

    for (let exit of exits) {
      exit.completed = exit.block.addn(challengePeriod).ltn(currentBlock)
      exit.finalized = await this.services.chaindb.checkFinalized(exit)
    }

    return exits
  }

  /**
   * Adds an exit to the database.
   * @param {Exit} exit Exit to add to database.
   */
  async addExit (exit) {
    await this.services.chaindb.addExit(exit)

    await this.lock.acquire('state', async () => {
      const stateManager = await this.loadState()
      stateManager.applyExit(exit)
      await this.saveState(stateManager)
    })
  }

  /**
   * Picks the best ranges to use for a transaction.
   * @param {string} address Address sending the transaction.
   * @param {BigNum} token Token being sent.
   * @param {BigNum} amount Amount of the token being sent.
   * @return {Array<Range>} Best ranges for the transaction.
   */
  async pickRanges (address, token, amount) {
    const stateManager = await this.loadState()
    return stateManager.pickRanges(address, token, amount)
  }

  /**
   * Picks the best transfers for an exit.
   * @param {string} address Address sending the transaction.
   * @param {BigNum} token Token being exited.
   * @param {BigNum} amount Amount of the token being exited.
   * @return {Array<Exit>} Best transfers for the exit.
   */
  async pickTransfers (address, token, amount) {
    const stateManager = await this.loadState()
    return stateManager.pickSnapshots(address, token, amount)
  }

  /**
   * Attempts to start exits for a user.
   * @param {string} address Address starting the exit.
   * @param {BigNum} token Token being exited.
   * @param {BigNum} amount Amount of the token being exited.
   */
  async startExit (address, token, amount) {
    const transfers = await this.pickTransfers(address, token, amount)

    let exited = []
    let exitTxHashes = []
    for (let transfer of transfers) {
      try {
        const exitTx = await this.services.contract.startExit(
          transfer.block,
          transfer.token,
          transfer.start,
          transfer.end,
          address
        )
        exitTxHashes.push(exitTx.transactionHash)
        exited.push(transfer)
      } catch (err) {
        this.logger(`ERROR: ${err}`)
      }
    }

    return exitTxHashes
  }

  /**
   * Attempts to finalized exits for a user.
   * @param {string} address Address to finalize exits for.
   */
  async finalizeExits (address) {
    const exits = await this.getExitsWithStatus(address)
    const completed = exits.filter((exit) => {
      return exit.completed && !exit.finalized
    })

    let finalized = []
    let finalizedTxHashes = []
    for (let exit of completed) {
      try {
        const exitableEnd = await this.services.chaindb.getExitableEnd(
          exit.token,
          exit.end
        )
        const finalizeTx = await this.services.contract.finalizeExit(
          exit.id,
          exitableEnd,
          address
        )
        finalizedTxHashes.push(finalizeTx.transactionHash)
        finalized.push(exit)
      } catch (err) {
        this.logger(`ERROR: ${err}`)
      }
    }

    return finalizedTxHashes
  }

  /**
   * Adds a new transaction to a history if it's valid.
   * @param {*} transaction A Transaction object.
   * @param {*} deposits A list of deposits for the transaction.
   * @param {*} proof A Proof object.
   */
  async addTransaction (transaction, deposits, proof) {
    const tx = new SignedTransaction(transaction)

    this.logger(`Verifying transaction proof for: ${tx.hash}`)
    try {
      await this.services.proof.checkProof(tx, deposits, proof)
    } catch (e) {
      this.logger(`ERROR: Rejecting transaction proof for: ${tx.hash}`)
      throw new Error('Invalid transaction proof')
    }

    this.logger(`Verified transaction proof for: ${tx.hash}`)

    // Calculate the new state.
    this.logger(`Computing new verified state for: ${tx.hash}`)
    const tempManager = new SnapshotManager()
    this.services.proof.applyProof(tempManager, deposits, proof)
    this.logger(`Computed new verified state for: ${tx.hash}`)

    // Merge and save the new head state.
    this.logger(`Saving head state for: ${tx.hash}`)
    await this.lock.acquire('state', async () => {
      const stateManager = await this.loadState()
      stateManager.merge(tempManager)
      this.saveState(stateManager)
    })
    this.logger(`Saved head state for: ${tx.hash}`)

    // Store the transaction and proof information.
    this.logger(`Adding transaction to database: ${tx.hash}`)
    await this.services.chaindb.setTransaction(tx)
    await this.services.chaindb.setTransactionProof(tx.hash, proof)
    this.logger(`Added transaction to database: ${tx.hash}`)
  }

  /**
   * Sends a transaction to the operator.
   * @param {SignedTransaction} transaction A signed transaction.
   */
  async sendTransaction (transaction) {
    const tx = new SignedTransaction(transaction)
    // TODO: Make sure the transaction is valid.
    // This relies on the revamp of internal storage, not really important for now.

    // TODO: Check that the transaction receipt is valid.
    this.logger(`Sending transaction to operator: ${tx.hash}.`)
    const receipt = await this.services.operator.sendTransaction(tx)
    this.logger(`Sent transaction to operator: ${tx.hash}.`)

    this.logger(`Adding transaction to database: ${tx.hash}`)
    await this.lock.acquire('state', async () => {
      const stateManager = await this.loadState()
      stateManager.applySentTransaction(tx)
      this.saveState(stateManager)
    })
    await this.services.chaindb.setTransaction(tx)
    this.logger(`Added transaction to database: ${tx.hash}.`)

    return receipt
  }

  /**
   * Sends a malicious transaction that the operator supports.
   * With more time, this should be in the plasma-chain repo as
   * a mock function
   * @param {SignedTransaction} transaction A signed transaction.
   */
  async sendMaliciousTransaction (transaction) {
    const tx = new SignedTransaction(transaction)
    // TODO: Make sure the transaction is valid.
    // This relies on the revamp of internal storage, not really important for now.

    // TODO: Check that the transaction receipt is valid.
    this.logger(`Sending transaction to operator: ${tx.hash}.`)
    const receipt = await this.services.operator.sendTransaction(tx)
    this.logger(`Sent transaction to operator: ${tx.hash}.`)

    this.logger(`Adding transaction to database: ${tx.hash}`)
    await this.lock.acquire('state', async () => {
      const stateManager = await this.loadState()
      stateManager.applySentTransaction(tx)
      this.saveState(stateManager)
    })
    await this.services.chaindb.setTransaction(tx)
    this.logger(`Added transaction to database: ${tx.hash}.`)

    return receipt
  }

  /**
   * Loads the current head state as a SnapshotManager.
   * @return {SnapshotManager} Current head state.
   */
  async loadState () {
    const state = await this.services.chaindb.getState()
    return new SnapshotManager(state)
  }

  /**
   * Saves the current head state from a SnapshotManager.
   * @param {SnapshotManager} stateManager A SnapshotManager.
   */
  async saveState (stateManager) {
    const state = stateManager.state
    await this.services.chaindb.setState(state)
  }
}

module.exports = ChainService
