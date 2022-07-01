import { Observable } from 'lib0/observable.js'
import fetch from 'cross-fetch';

export default class GoogleDriveStorageAdapter extends Observable {
  constructor (directory, accessToken) {
    super()
    this.directory = directory
    this.accessToken = accessToken
    this.listingCache = null
    this.directoryEntry = null

    this.online = false
  }

  async getFileList (pattern, allowCachedList = false) {
    const returnObj = {}
    await this.refreshListingCache()
    for (let file in this.listingCache)
    {
      if (file.startsWith(pattern) && this.listingCache[file].mimeType != "application/vnd.google-apps.folder")
      {
        returnObj[file] = {name: file, uniqueId: this.listingCache[file].md5Checksum}
      }
    }
    if (!this.online)
    {
      this.emit('online', [this])
      this.online = true
    }
    return returnObj
  }

  async getFile (filename) {
    if (!this.listingCache)
    {
      await this.refreshListingCache()
    }
    let fileId = null
    if (filename in this.listingCache)
    {
      fileId = this.listingCache[filename].id
    }
    else
    {
      throw "getFile: File not found in listing cache"
    }
    const fileGetOptions = {
      method: "GET",
      headers: {
        Authorization: "Bearer "+this.accessToken
      }
    }
    const metaResp = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?" + new URLSearchParams({
      fields: "id,kind,mimeType,name,md5Checksum,originalFilename,parents"
    }), fileGetOptions)
    if (metaResp.status >= 400)
    {
      throw "getFile: Got HTTP error "+metaResp.status.toString()
    }
    const meta = await metaResp.json()

    const resp = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media", fileGetOptions)
    if (resp.status >= 400)
    {
      throw "getFile: Got HTTP error "+resp.status.toString()
    }
    const blob = await resp.blob()
    const contents = await blob.arrayBuffer()
    const obj = {
      contents: Buffer.from(contents),
      uniqueId: meta.md5Checksum
    }
    return obj
  }

  async refreshListingCache() {

    const fileListOptions = {
      method: "GET",
      headers: {
        Authorization: "Bearer "+this.accessToken
      }
    }
    // TODO: Restrict listing to specifc directory within drive
    const fileListResponse = await fetch("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
      pageSize: 1000,
      fields: "files(id,kind,mimeType,name,md5Checksum,originalFilename,parents)"
    }), fileListOptions)
    if (fileListResponse.status >= 400)
    {
      throw "refreshListingCache: Got HTTP error "+fileListResponse.status.toString()
    }
    const fileList = await fileListResponse.json()
    if (fileList.files)
    {
      this.listingCache = {}
      const directoryEntries = fileList.files.filter(f => (f.kind == "drive#file" && f.mimeType == "application/vnd.google-apps.folder" && f.name == this.directory))
      if (directoryEntries.length > 0)
      {
        this.directoryEntry = directoryEntries[0]
        for (let ind in fileList.files)
        {
          if (fileList.files[ind].parents.indexOf(this.directoryEntry.id) >= 0)
          {
            this.listingCache[fileList.files[ind].name] = fileList.files[ind]
          }
        }
      }
    }
    else if(fileList.error && fileList.error.code == 401)
    {
      throw "refreshListingCache: Invalid auth or old token"
    }
    else
    {
      throw "refreshListingCache: Google Drive did not return file list"
    }
    // TODO: Implement iterating over multiple pages. Only allowed to get up to 1000 files per request
  }

  async putFile (filename, contents) {
    if (!this.listingCache)
    {
      await this.refreshListingCache()
    }
    if (this.directoryEntry.length <= 0)
    {
      const createFolderOptions = {
        method: "PUT",
        headers: {
          Authorization: "Bearer "+this.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mimeType: "application/vnd.google-apps.folder",
          name: this.directory,
        }),
      };

      const response = await fetch("https://www.googleapis.com/drive/v3/files", createFolderOptions);
      if (response.status >= 400)
      {
        throw "putFile: Got HTTP error "+response.status.toString()
      }
      const json = await response.json();

      await this.refreshListingCache()
    }
    if (this.directoryEntry.length <= 0)
    {
      throw "putFile: Failed to create main directory on Google Drive"
    }

    let startUploadOptions = {
      method: "POST",
      headers: {
        Authorization: "Bearer "+this.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: filename,
        mimeType: (typeof contents == "string" ? "text/plain" : "application/octet-stream"),
        parents: [this.directoryEntry.id]
      }),
    };
    let uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"

    /* Alternate options and URL for overwriting existing file */
    if (filename in this.listingCache)
    {
      startUploadOptions = {
        method: "PATCH",
        headers: {
          Authorization: "Bearer "+this.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mimeType: (typeof contents == "string" ? "text/plain" : "application/octet-stream"),
        }),
      };
      uploadUrl = "https://www.googleapis.com/upload/drive/v3/files/" + this.listingCache[filename].id + "?uploadType=resumable"
    }
    const startUploadResponse = await fetch(uploadUrl, startUploadOptions)
    if (startUploadResponse.status >= 400)
    {
      throw "putFile: Got HTTP error "+startUploadResponse.status.toString()
    }

    const resumableURI = startUploadResponse.headers.get('location')

    const totalSize = contents.length
    let positionInUpload = 0
    const maxChunk = 262144
    while (positionInUpload < totalSize)
    {
      const chunkSize = (totalSize - positionInUpload) > maxChunk ? maxChunk : (totalSize - positionInUpload)

      const upload_options = {
        method: "PUT",
        headers: {
          Authorization: "Bearer "+this.accessToken,
          "Content-Length": chunkSize,
          "Content-Range": "bytes "+positionInUpload.toString()+"-"+(positionInUpload + chunkSize - 1).toString()+"/"+totalSize.toString(),
        },
        body: contents.slice(positionInUpload, positionInUpload + chunkSize),
      };

      const uResponse = await fetch(resumableURI, upload_options);
      if (uResponse.status >= 400)
      {
        throw "putFile: Got HTTP error "+uResponse.status.toString()
      }
      const uploadResponse = await uResponse.text();

      positionInUpload += chunkSize
    }
    /* Refresh cache since we likely changed things */
    await this.refreshListingCache()

  }

  async deleteFile (filename) {
    if (!this.listingCache)
    {
      await this.refreshListingCache()
    }
    let fileId = null
    if (filename in this.listingCache)
    {
      fileId = this.listingCache[filename].id
    }
    else
    {
      throw "deleteFile: File not found in listing cache"
    }
    const fileDeleteOptions = {
      method: "DELETE",
      headers: {
        Authorization: "Bearer "+this.accessToken
      }
    }
    const metaResp = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId, fileDeleteOptions)
    if (metaResp.status >= 400)
    {
      throw "deleteFile: Got HTTP error "+metaResp.status.toString()
    }
  }
}

