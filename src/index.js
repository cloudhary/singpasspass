const fs = require('fs');
const https = require('https');
const url = require('url');
const assert = require('assert');
const path = require('path');
const express = require('express');
const Provider = require('oidc-provider');
const helmet = require('helmet');
const routes = require('./routes');

// set defaults for local usage
const { PORT = 3000, ISSUER = 'http://redis_db:6739', TIMEOUT } = process.env;

if (process.env.NODE_ENV === 'production') {
  assert(
    process.env.SECURE_KEY,
    'process.env.SECURE_KEY missing, run `heroku addons:create securekey`',
  );
  assert.equal(
    process.env.SECURE_KEY.split(',').length,
    2,
    'process.env.SECURE_KEY format invalid',
  );
}
assert(
  process.env.REDIS_URL,
  'process.env.REDIS_URL missing, run `heroku-redis:hobby-dev`',
);

const RedisAdapter = require('./redis_adapter');

// simple account model for this application, user list is defined like so
const Account = require('./account');

const oidc = new Provider(ISSUER, {
  cookies: {
    short: {
      secure: true,
    },
    long: {
      secure: true,
    },
  },
  // oidc-provider only looks up the accounts by their ID when it has to read the claims,
  // passing it our Account model method is sufficient, it should return a Promise that resolves
  // with an object with accountId property and a claims method.
  findById: Account.findById,

  // let's tell oidc-provider we also support the email scope, which will contain email and
  // email_verified claims
  claims: {
    // scope: [claims] format
    openid: ['sub'],
    email: ['email', 'email_verified'],
  },

  // let's tell oidc-provider where our own interactions will be
  // setting a nested route is just good practice so that users
  // don't run into weird issues with multiple interactions open
  // at a time.
  interactionUrl(ctx) {
    return `/interaction/${ctx.oidc.uuid}`;
  },
  formats: {
    AccessToken: 'jwt',
  },
  features: {
    // disable the packaged interactions
    // devInteractions: false,

    claimsParameter: true,
    discovery: true,
    encryption: true,
    introspection: true,
    registration: true,
    request: true,
    revocation: true,
    sessionManagement: true,
  },
});

if (TIMEOUT) {
  oidc.defaultHttpOptions = { timeout: parseInt(TIMEOUT, 10) };
}

const keystore = require('./keystore.json');

oidc
  .initialize({
    keystore,
    clients: [
      // reconfigured the foo client for the purpose of showing the adapter working
      {
        client_id: 'foo',
        redirect_uris: [
          'https://peaceful-yonath-ac1071.netlify.com',
          'https://openidconnect.net/callback',
        ],
        response_types: ['id_token token'],
        grant_types: ['implicit'],
        token_endpoint_auth_method: 'none',
      },
    ],
    adapter: RedisAdapter,
  })
  .then(() => {
    oidc.proxy = true;
    oidc.keys = process.env.SECURE_KEY.split(',');
  })
  .then(() => {
    const app = express();

    // security
    app.use(helmet());
    app.set('trust proxy', true);

    // UI
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, 'views'));

    // HTTPS only
    app.use((req, res, next) => {
      if (req.secure) {
        next();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(
          url.format({
            protocol: 'https',
            host: req.get('host'),
            pathname: req.originalUrl,
          }),
        );
      } else {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'do yourself a favor and only use https',
        });
      }
    });

    routes(app, oidc);
    // leave the rest of the requests to be handled by oidc-provider, there's a catch all 404 there
    app.use(oidc.callback);

    // express listen
    if (process.env.NODE_ENV === 'production') {
      app.listen(PORT);
    } else {
      const certOptions = {
        key: fs.readFileSync(path.resolve('server.key')),
        cert: fs.readFileSync(path.resolve('server.crt')),
      };
      https.createServer(certOptions, app).listen(PORT);
    }
  });
