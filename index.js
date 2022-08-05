const Sentry = require('@sentry/node')

if (process.env.NODE_ENV === 'production') {
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN
    })
  }
} else {
  require('dotenv').config()
}

const {
  MONGO_URI,
  WEB3_URI,
  PROCESS_TYPE
} = process.env

if (!MONGO_URI) throw new Error('Invalid MONGO_URI')
if (!WEB3_URI) throw new Error('Invalid WEB3_URI')

const mongoose = require('mongoose')
const fs = require('fs')
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useCreateIndex: true, useUnifiedTopology: true })

setTimeout(function(){ exit() }, 3600000);

function create_lock(cb) {
  var fname = 'scraper.pid';
  fs.appendFile(fname, process.pid.toString(), function (err) {
    if (err) {
      console.log("Error: unable to create %s", fname);
      process.exit(1);
    } else {
      return cb();
    }
  });
}

function remove_lock(cb) {
  var fname = 'scraper.pid';
  fs.unlink(fname, function (err){
    if(err) {
      console.log("unable to remove lock: %s", fname);
      process.exit(1);
    } else {
      return cb();
    }
  });
}

function is_locked(cb) {
  var fname = 'scraper.pid';
  fs.exists(fname, function (exists){
    if(exists) {
      return cb(true);
    } else {
      return cb(false);
    }
  });
}

function exit() {
  remove_lock(function(){
    mongoose.disconnect();
    process.exit(0);
  });
}

function stop(signal) {
  return async function () {
    console.log('Received', signal)
    exit()
  }
}

is_locked(function (exists) {
  if (exists) {
    console.log("Script already running..");
    process.exit(1);
  } else {
    create_lock(function (){
      process.on('SIGTERM', stop('SIGTERM'))
      process.on('SIGINT', stop('SIGINT'))
      switch (PROCESS_TYPE) {
        case 'api':
          require('./api')
          break
        case 'scraper':
          require('./scraper')
          break
        default:
          require('./api')
          require('./scraper')
      }
    })
  }
})