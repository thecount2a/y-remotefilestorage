import * as Y from 'yjs'
import { Observable } from 'lib0/observable.js'

export const PREFERRED_MAX_UPDATE_SIZE = 50000
export const RATIO_OF_UPDATE_FILES_TO_CLEANUP = 0.5

export const fetchUpdates = async (rfsPersistence, allowCachedList = true) => {
  let initialYdoc = null
  const lst = await rfsPersistence.storage.getFileList(rfsPersistence.name, allowCachedList)
  if (!rfsPersistence.initialSyncDone)
  {
    initialYdoc = new Y.Doc();
  }
  for (let fname in lst)
  {
    /* Do we have a fully-valid version of this file in the cache? If so, omit it for performance reasons */
    const cacheHit = await rfsPersistence.storage.doesFileCacheHit(fname)
    if (!cacheHit || !rfsPersistence.initialSyncDone)
    {
      const fobj = await rfsPersistence.storage.getFile(fname)
      if (!cacheHit)
      {
        Y.applyUpdate(rfsPersistence.doc, fobj.contents, rfsPersistence)
      }
      if (!rfsPersistence.initialSyncDone)
      {
        Y.applyUpdate(initialYdoc, fobj.contents)
      }
    }
  }
  if (!rfsPersistence.initialSyncDone)
  {
    rfsPersistence.initialState = Y.encodeStateVector(initialYdoc)
    initialYdoc.destroy()
  }
}

export const getSecondsIndex = () => {
  const now = new Date()
  return Math.floor(now/1e3)
}

export const flushState = async (rfsPersistence, forceRollup = false) => {
  if (!rfsPersistence.initialSyncDone)
  {
    console.log("WARNING! Flushing state without initial sync done")
  }
  if (!rfsPersistence.flushing)
  {
    rfsPersistence.flushing = true
    /* Store number of updates that we are processing now */
    const numberOfUpdates = rfsPersistence.cachedUpdate.length

    const secondsIndex = getSecondsIndex()
    try
    {
      let candidate = null
      if (numberOfUpdates > 0)
      {
        let sz = 0
        for (let i in rfsPersistence.cachedUpdate)
        {
          sz+= rfsPersistence.cachedUpdate[i].length
        }
        candidate = Y.mergeUpdates(rfsPersistence.cachedUpdate.slice(0, numberOfUpdates))
        /* Make sure to filter out anything in this update that was also in the initial state */
        if (rfsPersistence.initialState)
        {
          candidate = Y.diffUpdate(candidate, rfsPersistence.initialState)
        }

        if (rfsPersistence.currentSecondsIndex === null)
        {
          rfsPersistence.currentSecondsIndex = secondsIndex
        }
        const updateFileName = rfsPersistence.name+'.'+rfsPersistence.actorId+'.'+rfsPersistence.currentSecondsIndex.toString()+'.'+rfsPersistence.doc.clientID.toString()+'.'+rfsPersistence.currentUpdateIndex+'.update'

        /* Try to upload file. If we are offline, this will fail */
        await rfsPersistence.storage.putFile(updateFileName, candidate)

        /* Now that upload has completed successfully without any exceptions, let's remove the uploaded updates from list
         *   if the update size is getting too too big */
        if (candidate.length >= PREFERRED_MAX_UPDATE_SIZE)
        {
          rfsPersistence.currentUpdateIndex++
          rfsPersistence.currentSecondsIndex = secondsIndex
          /* Actually remove updates from future uploads if we are advancing to a new update file */
          rfsPersistence.cachedUpdate = rfsPersistence.cachedUpdate.slice(numberOfUpdates)
        }
      }

      const lst = await rfsPersistence.storage.getFileList(rfsPersistence.name, true)
      const thisActorFiles = []
      for (let fname in lst)
      {
        if (fname.startsWith(rfsPersistence.name+'.'+rfsPersistence.actorId+'.') && fname.endsWith('.update'))
        {
          thisActorFiles.push(fname)
        }
      }
      if (forceRollup || thisActorFiles.length >= (rfsPersistence.maxUpdateFiles + 1))
      {
        await fetchUpdates(rfsPersistence, false)

        thisActorFiles.sort()
        const rollupUpdates = []
        const rollupUpdatesFileNames = []
        /* Collect list of updates that will be rolled up */
        for (let i = 0; i < thisActorFiles.length * RATIO_OF_UPDATE_FILES_TO_CLEANUP; i++)
        {
          const updateDataObj = await rfsPersistence.storage.getFile(thisActorFiles[i])
          rollupUpdates.push(updateDataObj.contents)
          rollupUpdatesFileNames.push(thisActorFiles[i])
        }

        if (rfsPersistence.rollupStrategy == "rollupeverything")
        {
          await rfsPersistence.storage.putFile(rfsPersistence.name+'.'+rfsPersistence.actorId+'.doc', Y.encodeStateAsUpdate(rfsPersistence.doc))
        }
        else if (rfsPersistence.rollupStrategy == "rollupactordata")
        {
          const ydoc = new Y.Doc();
          if (rfsPersistence.name+'.'+rfsPersistence.actorId+'.doc' in lst)
          {
            const main_doc = await rfsPersistence.storage.getFile(rfsPersistence.name+'.'+rfsPersistence.actorId+'.doc')
            Y.applyUpdate(ydoc, main_doc.contents)
          }
          for (let i in rollupUpdates)
          {
            Y.applyUpdate(ydoc, rollupUpdates[i])
          }
          let rollupUpdate = Y.encodeStateAsUpdate(ydoc)
          await rfsPersistence.storage.putFile(rfsPersistence.name+'.'+rfsPersistence.actorId+'.doc', rollupUpdate)
          ydoc.destroy()
        }

        /* Delete rolled up files from remote storage */
        for (let i in rollupUpdatesFileNames)
        {
            await rfsPersistence.storage.deleteFile(rollupUpdatesFileNames[i])
        }
      }
    } finally {
      rfsPersistence.flushing = false
    }
  }
  else
  {
    console.log("Flushing triggered while flushing is still ongoing")
  }
}

/**
 * @extends Observable<string>
 */
export default class RemoteFileStoragePersistence extends Observable {
  constructor (name, doc, actorId, storageAdapter, maxUpdateFiles = 20, rollupStrategy = "rollupeverything") {
    super()
    this.doc = doc
    this.name = name
    this.actorId = actorId
    this.initialSyncDone = false
    this.initialState = null
    this.storage = storageAdapter
    this.cachedUpdate = []
    this.flushing = false
    this.currentUpdateIndex = 0
    this.currentSecondsIndex = null
    this.maxUpdateFiles = maxUpdateFiles
    /* This strategy affects how the main doc is aggregated which in turn affects how much storage space is used
     * versus how much memory and CPU it takes to do rollups.
     *    "rollupeverything"         -- This strategy uses the most remote disk space since each actor keeps their own complete copy of the 
     *                                          document on the remote storage in separate files.
     *
     *    "rollupactordata"          -- This strategy rolls up only data from each actor into that actor's main doc. This uses more memory
     *                                          during rollup since each it must load the actor's view of the doc into memory, in addition 
     *                                          to holding the main ydoc in memory.
     */
    this.rollupStrategy = rollupStrategy

    this._checkInitialSync = async () => {
      if (!this.initialSyncDone)
      {
        await fetchUpdates(this, false)
        this.initialSyncDone = true
        this.emit('synced', [this])
      }
    }

    this._onOnline = async () => {
      await this._checkInitialSync()
    }
    /* When storage providers know they are back in touch with their server, they emit this */
    this.storage.on('online', this._onOnline)

    this._onPullUpdates = async () => {
      if (this.initialSyncDone)
      {
        await fetchUpdates(this, false)
      }
    }
    /* When storage providers want to be polled, they emit this, or if they have knowledge about new remote file contents they may also pull */
    this.storage.on('pullupdates', this._onPullUpdates)

    /**
     * Timeout in ms until data is persisted on remote
     */
    this._flushTimeout = 5000
    this._flushTimeoutId = null
    this._storeUpdate = async (update, origin) =>
    {
      if (origin !== this)
      {
        this.cachedUpdate.push(update)

        /* If initial sync has not finished, cache this update until initial sync has taken place */
        if (this.initialSyncDone)
        {
          // debounce flush call
          if (this._flushTimeoutId !== null)
          {
            clearTimeout(this._flushTimeoutId)
          }
          this._flushTimeoutId = setTimeout(async () =>
          {
            this._flushTimeoutId = null
            await flushState(this, false)
          }, this._flushTimeout)
        }
      }
    }

    doc.on('update', this._storeUpdate)
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', this.destroy)
  }

  async forceFlushState()
  {
    await this._checkInitialSync()
    await flushState(this, false)
  }

  async forceRollup()
  {
    await this._checkInitialSync()
    await flushState(this, true)
  }

  async destroy ()
  {
    if (this._flushTimeoutId)
    {
      clearTimeout(this._flushTimeoutId)
    }
    if (this.cachedUpdate.length > 0)
    {
      await this._checkInitialSync()
    }
    while (this.cachedUpdate.length > 0)
    {
      await flushState(this, false)
      /* Whoops, if more state has shown up since last time the state began flushing, wait for it all to flush */
      if (this.cachedUpdate.length > 0)
      {
        await new Promise((resolve, reject) =>
          {
            setTimeout(() =>
              {
                resolve()
              }, 10)
          }
        )
      }
    }
    this.doc.off('update', this._storeUpdate)
    this.doc.off('destroy', this.destroy)
    this.storage.off('online', this._onOnline)
    this.storage.off('pullupdates', this._onPullUpdates)
  }

}
