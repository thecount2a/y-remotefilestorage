import * as Y from 'yjs'
import * as fs from 'fs';
import * as process from 'process';

import RemoteFileStoragePersistence from './y-remotefilestorage.js'
import NodejsLocalFileStorageAdapter from './y-nodejsstorageadapter.js'
import DoubleRatchetEncryptionAddonAdapter from './y-double-ratchet-encryption-addon-adapter.js'
import DoubleRatchetFileStorage from './double-ratchet-file-storage.js'
import { IndexeddbPersistence } from 'y-indexeddb'


var txt = `2012-01-08 * "EDISON POWER" | ""
  Assets:US:BofA:Checking                                -65.00 USD
  Expenses:Home:Electricity                               65.00 USD

;2012-01-21 balance Assets:US:BofA:Checking              3169.54 USD

2012-01-22 * "Wine-Tarner Cable" | ""
  Assets:US:BofA:Checking                                -80.06 USD
  Expenses:Home:Internet                                  80.06 USD

2012-02-04 * "BANK FEES" | "Monthly bank fee"
  Assets:US:BofA:Checking                                 -4.00 USD
  Expenses:Financial:Fees                                  4.00 USD

2012-02-05 * "RiverBank Properties" | "Paying the rent"
  Assets:US:BofA:Checking                              -2400.00 USD
  Expenses:Home:Rent                                    2400.00 USD

`;

const ydoc = new Y.Doc()
const ydoc1 = new Y.Doc()
const ydoc2 = new Y.Doc()

const rootAdapter = new NodejsLocalFileStorageAdapter("./storage")
let actorId = "1"
if (process.argv.length > 2)
{
  actorId = process.argv[2]
}
let action = "none"
if (process.argv.length > 3)
{
  action = process.argv[3]
}

const channel = new DoubleRatchetFileStorage(rootAdapter, actorId, "mydevice"+actorId , "mydevice"+actorId);


const adapter1 = new DoubleRatchetEncryptionAddonAdapter(rootAdapter, channel, './enc_info'+actorId)
const provider1 = new RemoteFileStoragePersistence("main", ydoc1, actorId, adapter1, 4, 'rollupactordata', "filestoragecache"+actorId);

await channel.loadState()
await channel.sync()
for (let peer in channel.peers)
{
  if (channel.peers[peer].state != "verified")
  {
    console.log("Setting peer "+peer+" to verified")
    await channel.markPeerTrusted(peer)
  }
}
await channel.sync()

if (action == "edit" || action == "sync")
{
  provider1.once('synced', async function() {
    const ymap = ydoc1.getMap('mydoc')
    let ytext = ymap.get('myledger')
    if (!ytext)
    {
      console.log("Setting map!")
      ytext = new Y.Text()
      ymap.set('myledger', ytext)
    }
    if (action == "edit")
    {
      for (var i = 0; i < 70;i++)
      {
	ytext.insert(ytext.length,txt);
      }

      for (var i = 0; i < 20;i++)
      {
	ytext.insert(ytext.length,txt);
      }
      for (var i = 0; i < 5;i++)
      {
	ytext.delete(ytext.length-500,30);
      }
    }

    //adapter2.emit('pullupdates', [this])

    const ytext1 = ydoc1.getMap('mydoc').get('myledger')
    console.log("Text with length")
    console.log(ytext1.length)

    if (action == "edit")
    {
      await provider1.forceFlushState()
    }

    await provider1.destroy()
    await channel.sync()
  })

  adapter1.emit('online', [this])
}
else
{
  await provider1.destroy()
  await channel.sync()
}
