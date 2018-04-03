const {
  BaseKonnector,
  saveFiles,
  updateOrCreate,
  cozyClient,
  log
} = require('cozy-konnector-libs')
const fb = require('fb')

module.exports = new BaseKonnector(start)

/**
 * @param  {} fields:
 * @param {} fields.access_token: a facebook access token
 */
async function start(fields) {
  const albums = await fetchData(fields)
  await synchronize(albums, fields)
}

// fetches albums and returns them in the form : {
//   "album name 1": ["image url 1", "image url 2"],
//   "album name 2": ["image url 3", "image url 4"],
//   ...
// }
async function fetchData({ accessToken }) {
  const result = {}
  try {
    const context = { accessToken }
    const albums = await fb.api('/me/albums', context)
    for (const { id, name } of albums.data) {
      result[name] = []
      const photos = await fb.api(`/${id}/photos`, context)
      for (const { id } of photos.data) {
        const photoLink = await fb.api(`/${id}`, {
          fields: 'images',
          ...context
        })
        result[name].push(photoLink.images[0].source)
      }
    }
  } catch (err) {
    if (
      err.response &&
      err.response.error &&
      err.response.error.code &&
      err.response.error.code === 2500
    ) {
      log('error', 'Access token expired. You should renew your access token')
    }
  }
  return result
}

// synchronize fetched albums into the cozy
async function synchronize(albums, fields) {
  for (const albumName in albums) {
    // save the files to the cozy
    const picturesDocs = await saveFiles(
      albums[albumName].map(url => ({ fileurl: url })),
      fields.folderPath
    )
    const picturesIds = picturesDocs.map(doc => doc.fileDocument._id)

    // create the album if needed or fetch the correponding existing album
    const [albumDoc] = await updateOrCreate(
      [{ name: `Facebook ${albumName}` }],
      'io.cozy.photos.albums',
      ['name']
    )
    await referenceNewFilesInAlbum(albumDoc, picturesIds)
  }
}

async function referenceNewFilesInAlbum(album, fileIds) {
  const referencedFileIds = await cozyClient.data.listReferencedFiles(album)
  const newFileIds = fileIds.filter(id => !referencedFileIds.includes(id))
  await cozyClient.data.addReferencedFiles(album, newFileIds)
}
