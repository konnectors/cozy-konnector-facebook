const {
  BaseKonnector,
  saveFiles,
  updateOrCreate,
  cozyClient,
  normalizeFilename,
  log
} = require('cozy-konnector-libs')
const mkdirp = require('./mkdirp')
const fb = require('fb')
const { URL } = require('url')

process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://cbece4bebae0498fb3a0f99be70e988a:6703a424ebce43eca2bada22bbaa1f23@sentry.cozycloud.cc/40'

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
  log('info', `Fetching album "${name}"`)
  const picturesObjects = (await fetchListWithPaging(
    `/${id}/photos?fields=images`,
    context
  )).map(photo => {
    return { fileurl: photo.images[0].source }
  })

  // save the files to the cozy
  const albumName = await normalizeFilename(`Facebook ${name}`)
  const albumFolder = await mkdirp(fields.folderPath, albumName)
  const picturesDocs = await saveFiles(
    picturesObjects,
    albumFolder.attributes.path
  )
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
    const parsed = new URL(url, 'https://graph.facebook.com')
    const x = await fb.api(parsed.pathname + parsed.search, context)
    const { data, paging } = x
    url = paging && paging.next
    results = results.concat(data)
  }
  return results
}
