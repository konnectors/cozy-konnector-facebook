process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://cbece4bebae0498fb3a0f99be70e988a:6703a424ebce43eca2bada22bbaa1f23@sentry.cozycloud.cc/40'

const {
  BaseKonnector,
  saveFiles,
  updateOrCreate,
  cozyClient,
  normalizeFilename,
  log,
  errors
} = require('cozy-konnector-libs')
const fb = require('fb')
const format = require('date-fns/format')
const url = require('url')
const URL = url.URL
const path = require('path')

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
    const albums = await fetchListWithPaging.bind(this)('/me/albums', context)
    log('info', `Got ${albums.length} albums`)
    for (const album of albums)
      await fetchOneAlbum.bind(this)(album, context, fields)
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

  if (!firstRun) return account

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

    fields.folderPath = newFolder.attributes.path // eslint-disable-line require-atomic-updates

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
  const picturesObjects = (await fetchListWithPaging.bind(this)(
    `/${id}/photos?fields=id,images,backdated_time,created_time,place,tags`,
    context
  )).map(photo => {
    const fileurl = photo.images[0].source
    const extension = path.extname(url.parse(fileurl).pathname)
    const facebook_id = photo.id
    const time = new Date(photo.backdated_time || photo.created_time)
    const filename = `${format(time, 'YYYY_MM_DD')}_${photo.id}${extension}`
    return {
      fileurl,
      filename,
      facebook_id,
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
      concurrency: 8,
      contentType: 'image/jpeg', // need this to force the stack to take our date into account
      sourceAccount: this.accountId,
      sourceAccountIdentifier: this._account.label,
      fileIdAttributes: ['facebook_id']
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
  let refreshNb = 0
  while (url) {
    try {
      const parsed = new URL(url, 'https://graph.facebook.com')
      const x = await fb.api(parsed.pathname + parsed.search, context)
      const { data, paging } = x
      url = paging && paging.next
      results = results.concat(data)
    } catch (err) {
      log('warn', 'error while requesting facebook:')
      log('warn', err.message)
      if (refreshNb === 0) {
        try {
          log('info', 'refreshing the access_token')
          refreshNb++
          const body = await cozyClient.fetchJSON(
            'POST',
            `/accounts/facebook/${this._account._id}/refresh`
          )
          context.access_token = body.attributes.oauth.access_token // eslint-disable-line require-atomic-updates
        } catch (err) {
          log('info', `Error during refresh ${err.message}`)
          throw errors.USER_ACTION_NEEDED_OAUTH_OUTDATED
        }
      } else {
        throw err
      }
    }
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
