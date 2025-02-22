import Table from './table.js'

export default class TransactionsTable extends Table {
  constructor (dispatcher, index, total, nodeId, nodeType, currency, keyspace) {
    super(dispatcher, index, total, currency, keyspace)
    this.nodeId = nodeId
    this.nodeType = nodeType
    this.columns = [
      { name: 'Transaction',
        data: 'txHash',
        render: this.formatValue(this.truncateValue)
      },
      { name: 'Value',
        data: 'value',
        className: 'text-right',
        render: (value, type) =>
          this.formatValue(value => this.formatCurrency(value, keyspace, true))(value[this.currency], type)
      },
      { name: 'Height',
        data: 'height'
      },
      { name: 'Timestamp',
        data: 'timestamp',
        render: this.formatValue(this.formatTimestamp)
      }
    ]
    this.loadMessage = 'loadTransactions'
    this.resultField = 'transactions'
    this.selectMessage = 'clickTransaction'
    this.loadParams = [this.nodeId, this.nodeType]
  }
  getParams () {
    return {
      id: this.loadParams[0],
      type: this.loadParams[1],
      keyspace: this.keyspace
    }
  }
}
