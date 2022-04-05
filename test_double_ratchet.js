import * as fs from 'fs';
import * as process from 'process';
import NodejsLocalFileStorageAdapter from './y-nodejsstorageadapter.js'
import DoubleRatchetFileStorage from './double-ratchet-file-storage.js'

class kvstore {
  constructor () {
    this.map = {}
  }

  async get(k) {
    if (!(k in this.map))
    {
      return null
    }
    return this.map[k]
  }
  async set(k, val) {
    this.map[k] = val
  }
}
let append = ""
if (process.argv.length > 2)
{
  append = process.argv[2]
}
let actorId = 1
if (process.argv.length > 3)
{
  actorId = process.argv[3]
}
let chat = null
if (process.argv.length > 4)
{
  chat = process.argv[4]
}

const storageAdapter = new NodejsLocalFileStorageAdapter("chat")
const kv = new kvstore()
const channel = new DoubleRatchetFileStorage(storageAdapter, actorId, "mydevice"+append, k => kv.get(k), (k,v) => kv.set(k, v));
try
{
  kv.map = JSON.parse(fs.readFileSync("./state"+append).toString())
}
catch
{
}
console.log(kv.map)
await channel.loadState()

channel.on("messagesReceived", function(msgs) {
  for (let msg in msgs)
  {
    console.log("Received (from: "+msgs[msg].from+"): "+msgs[msg].body)
  }
})

for (let peer in channel.peers)
{
  if (channel.peers[peer].state != "verified")
  {
	console.log("Setting peer "+peer+" to verified")
	channel.peers[peer].state = "verified"
  }
}
await channel.sync()
let peers = Object.keys(channel.peers)
if (chat)
{
  console.log("Queuing outgoing message: "+chat)
  await channel.queueOutgoingMessage(peers[0], chat)
  await channel.sync()
}

await channel.saveState()


fs.writeFileSync("./state"+append, JSON.stringify(kv.map))

