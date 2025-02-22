import Table from './table.js'

export default class BlockTransactionsTable extends Table {
  constructor (dispatcher, index, total, height, currency, keyspace) {
    super(dispatcher, index, total, currency, keyspace)
    this.height = height
    this.columns = [
      { name: 'Transaction',
        data: 'txHash',
        render: this.formatValue(this.truncateValue)
      },
      { name: 'No. inputs',
        data: 'noInputs'
      },
      { name: 'No. outputs',
        data: 'noOutputs'
      },
      { name: 'Total input',
        data: 'totalInput',
        className: 'text-right',
        render: (value, type) =>
          this.formatValue(value => this.formatCurrency(value, keyspace, true))(value[this.currency], type)
      },
      { name: 'Total output',
        data: 'totalOutput',
        className: 'text-right',
        render: (value, type) =>
          this.formatValue(value => this.formatCurrency(value, keyspace, true))(value[this.currency], type)
      }
    ]
    this.loadMessage = 'loadTransactions'
    this.resultField = 'txs'
    this.selectMessage = 'clickTransaction'
    this.loadParams = [this.height, 'block']
    this.addOption(this.downloadOption())
  }
  getParams () {
    return {
      id: this.loadParams[0],
      type: this.loadParams[1],
      keyspace: this.keyspace
    }
  }
}
