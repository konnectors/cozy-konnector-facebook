// TODO: replace me by konnector/libs.mkdirp when
// https://github.com/konnectors/libs/pull/207 is merged

const { log, cozyClient: cozy } = require('cozy-konnector-libs')
const { basename, dirname, join } = require('path').posix

if (process.env.NODE_ENV === 'standalone') {
  cozy.data.listReferencedFiles = () => []
  cozy.data.addReferencedFiles = () => {}
}

return async function mkdirp(...pathComponents) {
  const path = join('/', ...pathComponents)
  const pathRepr = JSON.stringify(path)

  log('debug', `Checking wether directory ${pathRepr} exists...`)
  try {
    const doc = await cozy.files.statByPath(path)
    log('debug', `Directory ${pathRepr} found.`)
    return doc
  } catch (err) {
    if (err.status !== 404) throw err
    log('debug', `Directory ${pathRepr} not found.`)

    const name = basename(path)
    const parentPath = dirname(path)
    const parentDoc = await mkdirp(parentPath)

    log('info', `Creating directory ${pathRepr}...`)
    const doc = await cozy.files.createDirectory({
      name,
      dirID: parentDoc._id
    })
    log('info', `Directory ${pathRepr} created!`)
    return doc
  }
}
