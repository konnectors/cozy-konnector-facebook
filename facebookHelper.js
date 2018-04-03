/* eslint no-console: 0 */
const ConfigStore = require('configstore')
const pkg = require('./package.json')
const https = require('https')
const url = require('url')
const querystring = require('querystring')
const opn = require('opn')
const fb = require('fb')
const fs = require('fs')

const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')

const SCOPES = 'user_photos'

function getFacebookCode() {
  return new Promise((resolve, reject) => {
    // Open an http server to accept the oauth callback. In this simple example, the
    // only request to our webserver is to /oauthcallback?code=<code>
    const server = https
      .createServer(
        {
          key: fs.readFileSync('./key.pem'),
          cert: fs.readFileSync('./cert.pem')
        },
        async (req, res) => {
          if (req.url.indexOf('/oauthcallback') > -1) {
            // acquire the code from the querystring, and close the web server.
            const { code } = querystring.parse(url.parse(req.url).query)
            res.end(
              `Authentication successful! Please return to the console. [code: ${code}]`
            )
            server.close()
            resolve(code)
          }
          reject(new Error('oops', req, res))
        }
      )
      .listen(8000, () => {
        // open the browser to the authorize url to start the workflow
        // Generate the url that will be used for the consent dialog.

        const authorizeUrl = fb.getLoginUrl({
          client_id: getKeys().client_id,
          scope: SCOPES,
          redirect_uri: 'https://localhost:8000/oauthcallback'
        })
        console.log(authorizeUrl, 'authorize url')
        opn(authorizeUrl)
      })
  })
}

async function getToken() {
  const conf = new ConfigStore(pkg.name)
  const storedTokens = conf.get('facebook.tokens')
  if (storedTokens) {
    console.log(
      chalk.green(
        'Found token in your config file. If you want to reset it, run with `--reset`.'
      )
    )
    return storedTokens
  }
  console.log(
    chalk.green(
      'Authenticating you, check out your browser to fill the form out…'
    )
  )
  const keys = getKeys()
  const newToken = await getFacebookCode()
    .then(code => {
      return fb.api('oauth/access_token', {
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        code,
        redirect_uri: 'https://localhost:8000/oauthcallback'
      })
    })
    .then(res => res.access_token)
  conf.set('facebook.tokens', { access_token: newToken })
  return { access_token: newToken }
}

function resetConfigStore() {
  const conf = new ConfigStore(pkg.name)
  conf.delete('facebook.tokens')
}

function getFileContent(configFilename) {
  try {
    return require(`./${configFilename}`)
  } catch (err) {
    return {}
  }
}

function getKeys() {
  try {
    return require('./keys.json')
  } catch (ex) {
    console.log(
      chalk.red(
        'Unable to retrieve CLIENT_ID nor CLIENT_SECRET, please follow documentation to update keys.json file.'
      )
    )
    process.exit(-1)
  }
}

function getAccountInfo() {
  return fb.api('/me', {
    access_token: fb.getAccessToken().access_token
  })
}

clear()
console.log(
  chalk.yellow(
    figlet.textSync('Facebook API Helper', { horizontalLayout: 'full' })
  )
)

const KONNECTOR_DEV_CONFIG_FILE = 'konnector-dev-config.json'
const run = async () => {
  const {
    reset,
    filename: configFilename = KONNECTOR_DEV_CONFIG_FILE
  } = require('minimist')(process.argv.slice(2))
  reset && resetConfigStore()
  const accessToken = await getToken()
  fs.writeFileSync(
    `./${configFilename}`,
    JSON.stringify(
      {
        ...getFileContent(configFilename),
        fields: accessToken
      },
      null,
      2
    )
  )
  fb.setAccessToken(accessToken)
  const accountInfo = await getAccountInfo()
  console.log(
    chalk.green(
      `Find your credentials in ${configFilename} for ${accountInfo.name}`
    )
  )
}

run()
