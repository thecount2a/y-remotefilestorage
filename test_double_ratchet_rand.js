import * as fs from 'fs';
import * as process from 'process';
import NodejsLocalFileStorageAdapter from './y-nodejsstorageadapter-random-failure.js'
import DoubleRatchetFileStorage from './double-ratchet-file-storage.js'

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

let init = 333
//let init = 444
for (let arg in process.argv)
{
  //console.log("Buffer "+arg.toString())
  const buf = Buffer.from(process.argv[arg])
  for (let ch of buf)
  {
    init += ch
    //console.log(ch)
  }
}
console.log(init)

console.log("ARGS: "+(process.argv.slice(2).join(" ")))
const storageAdapter = new NodejsLocalFileStorageAdapter("chat", init)
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


