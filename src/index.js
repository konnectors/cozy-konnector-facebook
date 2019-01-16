const {
  BaseKonnector,
  saveFiles,
  updateOrCreate,
  cozyClient,
  normalizeFilename,
  log
} = require('cozy-konnector-libs')
const fb = require('fb')
const format = require('date-fns/format')
const url = require('url')
const URL = url.URL
const path = require('path')

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

    this._account = await ensureAccountNameAndFolder(
      this._account,
      fields,
      context
    )

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
    } else {
      throw err
    }
  }
}

async function ensureAccountNameAndFolder(account, fields, context) {
  const firstRun = !account || !account.label

  if (!firstRun) return

  try {
    log('info', `This is the first run, getting facebook account name`)
    const label = await normalizeFilename(await fetchMeName(context))

    log('info', `Updating the label of the account`)
    let newAccount = await cozyClient.data.updateAttributes(
      'io.cozy.accounts',
      account._id,
      {
        label,
        auth: {
          ...account.auth,
          accountName: label
        }
      }
    )

    log('info', `Renaming the folder to ${label}`)
    const newFolder = await cozyClient.files.updateAttributesByPath(
      fields.folderPath,
      {
        name: label
      }
    )

    fields.folderPath = newFolder.attributes.path

    log('info', `Updating the folder path in the account`)
    newAccount = await cozyClient.data.updateAttributes(
      'io.cozy.accounts',
      newAccount._id,
      {
        label,
        auth: {
          ...newAccount.auth,
          folderPath: fields.folderPath,
          namePath: label
        }
      }
    )
    return newAccount
  } catch (err) {
    log(
      'warn',
      `Error while trying to update folder path or account name: ${err.message}`
    )
  }
}

async function fetchMeName(context) {
  log('info', `Fetching "me"`)
  const parsed = new URL('/me', 'https://graph.facebook.com')
  const result = await fb.api(parsed.pathname + parsed.search, context)
  return result.name
}

async function fetchOneAlbum({ id, name, created_time }, context, fields) {
  log('info', `Fetching album "${name}"`)
  const picturesObjects = (await fetchListWithPaging(
    `/${id}/photos?fields=images,backdated_time,created_time,place,tags`,
    context
  )).map(photo => {
    const fileurl = photo.images[0].source
    const extension = path.extname(url.parse(fileurl).pathname)
    const time = new Date(photo.backdated_time || photo.created_time)
    const filename = `${format(time, 'YYYY_MM_DD')}_${photo.id}${extension}`
    return {
      fileurl,
      filename,
      fileAttributes: {
        lastModifiedDate: time
      }
    }
  })

  // save the files to the cozy
  const albumName = await normalizeFilename(`Facebook ${name}`)
  let picturesDocs = []
  if (picturesObjects.length) {
    picturesDocs = await saveFiles(picturesObjects, fields, {
      concurrency: 16,
      contentType: 'image/jpeg' // need this to force the stack to take our date into account
    })
  }
  const picturesIds = picturesDocs
    .filter(doc => doc && doc.fileDocument)
    .map(doc => doc.fileDocument._id)

  // create the album if needed or fetch the correponding existing album
  const [albumDoc] = await updateOrCreate(
    [{ name: albumName, created_at: created_time }],
    'io.cozy.photos.albums',
    ['name']
  )

  log('info', `${picturesIds.length} files proposed to add to ${albumName}`)
  const referencedFileIds = await listAllReferencedFiles(albumDoc)

  log('info', `${referencedFileIds.length} files referenced in ${albumName}`)
  const newFileIds = picturesIds.filter(id => !referencedFileIds.includes(id))
  log('info', `${newFileIds.length} files added to ${albumName}`)
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

async function listAllReferencedFiles(doc) {
  let list = []
  let result = {
    links: {
      next: `/data/${encodeURIComponent(doc._type)}/${
        doc._id
      }/relationships/references`
    }
  }
  while (result.links.next) {
    result = await cozyClient.fetchJSON('GET', result.links.next, null, {
      processJSONAPI: false
    })
    list = list.concat(result.data)
  }

  return list.map(doc => doc.id)
}
