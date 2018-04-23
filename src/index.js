const {
  BaseKonnector,
  saveFiles,
  updateOrCreate,
  cozyClient,
  mkdirp,
  normalizeFilename,
  log
} = require('cozy-konnector-libs')
const fb = require('fb')

module.exports = new BaseKonnector(start)

/**
 * @param  {} fields:
 * @param {} fields.access_token: a facebook access token
 */
async function start(fields) {
  try {
    const { access_token } = fields
    const context = { access_token }
    log('info', 'getting the list of albums')
    const albums = await fetchListWithPaging('/me/albums', context)
    log('info', `Got ${albums.length} albums`)
    for (const album of albums) await fetchOneAlbum(album, context, fields)
  } catch (err) {
    log('error', err.message)
    if (
      err.response &&
      err.response.error &&
      err.response.error.code &&
      err.response.error.code === 2500
    ) {
      log('error', 'Access token expired. You should renew your access token')
    }
  }
}

async function fetchOneAlbum({ id, name }, context, fields) {
  const picturesObjects = (await fetchListWithPaging(
    `/${id}/photos?fields=images`,
    context
  )).map(photo => {
    return { fileurl: photo.images[0].source }
  })

  // save the files to the cozy
  const albumName = normalizeFilename(`Facebook ${name}`)
  const albumFolder = mkdirp(fields.folderPath, albumName)
  const picturesDocs = await saveFiles(picturesObjects, albumFolder.path)
  const picturesIds = picturesDocs.map(doc => doc.fileDocument._id)

  // create the album if needed or fetch the correponding existing album
  const [albumDoc] = await updateOrCreate(
    [{ name: albumName }],
    'io.cozy.photos.albums',
    ['name']
  )

  const referencedFileIds = await cozyClient.data.listReferencedFiles(albumDoc)
  const newFileIds = picturesIds.filter(id => !referencedFileIds.includes(id))
  await cozyClient.data.addReferencedFiles(albumDoc, newFileIds)
}

async function fetchListWithPaging(url, context) {
  let results = []
  while (url) {
    const x = await fb.api(url, context)
    const { data, paging } = x
    url = paging && paging.next
    results = results.concat(data)
  }
  return results
}
