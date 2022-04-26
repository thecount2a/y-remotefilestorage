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
let chatto = null
if (process.argv.length > 5)
{
  chatto = process.argv[4]
  chat = process.argv[5]
}

const storageAdapter = new NodejsLocalFileStorageAdapter("chat")
const channel = new DoubleRatchetFileStorage(storageAdapter, actorId, "mydevice"+append, "mydevice"+append);
await channel.loadState()
console.log(channel.peers)

channel.on("messagesReceived", function(msgs) {
  for (let msg in msgs)
  {
    console.log("Received (from: "+msgs[msg].from+"): "+msgs[msg].body)
  }
})

try
{
  for (let peer in channel.peers)
  {
    if (channel.peers[peer].state != "verified")
    {
      console.log("Setting peer "+peer+" to verified")
      await channel.markPeerTrusted(peer)
    }
  }
  await channel.sync()
  let peers = Object.keys(channel.peers)
  if (chat)
  {
    console.log("Queuing outgoing message: "+chat)
    await channel.queueOutgoingMessage(chatto, chat)
    await channel.sync()
  }
}
finally
{
  const memJson = JSON.stringify(channel.peers)
  const stateObj = await channel.loadStateObject()
  const storedJson = JSON.stringify(stateObj.peers)
  if (memJson != storedJson)
  {
    console.log("ERROR: Stored peer JSON is different than memory JSON (or this session is new and object keys are not yet sorted)")
    console.log(storedJson)
    console.log(memJson)
  }
  for (let peer in channel.sessions)
  {
    if (channel.sessions[peer].pickle('fixed_insecure_key') != stateObj.peers[peer].session)
    {
      console.log("ERROR: Stored session pickle for peer "+peer+" is different than memory session")
    }
  }
  if (channel.account.pickle('fixed_insecure_key') != stateObj.account)
  {
    console.log("ERROR: Stored account pickle is different than memory account")
  }
  console.log("Done checking DB consistency")
}

console.log(channel.peers)
