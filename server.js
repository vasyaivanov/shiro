var server   = require('http').createServer()
  , path     = require('path')

  // thrid-party
  , async    = require('async')
  , merge    = require('deeply')
  , envar    = require('envar')
  , Wigwam   = require('wigwam')

  // lib
  , Chat     = require('./lib/chat')
  , Game     = require('./lib/game')

  // globals
  , wigwam // web server instance
  , chat   // chat instance
  , game   // game instance

  // default settings
  , defaults =
    { port   : 8500
    , path   : 'static'
    , data   : 'data'
    }

  // params handling
  , serverOptions
  , staticPath
  , dataPath
  ;

// {{{ prepare environment

// set defaut parameters
envar.defaults(defaults);

// {{{ get web server env setup

// make it absolute path
staticPath = envar('path')[0] == '/' ? envar('path') : path.join(__dirname, envar('path'));
dataPath = envar('data')[0] == '/' ? envar('data') : path.join(__dirname, envar('data'));

// web server options
serverOptions =
{
  static:
  {
    path           : staticPath,
    optionalHtmlExt: true
  },
  websockets:
  {
//    transformer  : 'engine.io',
    transformer  : 'socket.io',
    clientLibrary: path.join(staticPath, 'a/primus.js')
  }
};

// check for nocache flag
if (envar('nocache'))
{
  serverOptions = merge(serverOptions, {static: {cache: false}});
}
// init webserver
wigwam = new Wigwam(server, serverOptions);

// process events
wigwam.on('data connection disconnection', function wigwam_onData(socket, data)
{
  var event;

  // only objects
  if (typeof data != 'object') return;

  for (event in data)
  {
    if (!data.hasOwnProperty(event)) continue;

    // game goes first
    if (typeof game.events[event] == 'function')
    {
      game.events[event].call(this, socket, data[event]);
    }

    // then chat
    if (typeof chat.events[event] == 'function')
    {
      chat.events[event].call(this, socket, data[event]);
    }
  }

});

// }}}

// --- do stuff

main();

// main
function main()
{
  // get chat
  connectDb(function(err)
  {
    if (err) throw new Error('Cannot create chat instance. ' + err);

    // everything ready, open doors to the public
    startServer();
  });

}

// start web server
function startServer()
{
  wigwam.listen(envar('port'), envar('host'));
  console.log('listening on '+(envar('host') ? envar('host') + ':' : '')+envar('port'));
}

// connect to db
function connectDb(callback)
{
  async.parallel(
  {
    // get chat data
    chat: function(asyncCb)
    {
      chat = new Chat({storage: path.join(dataPath, 'chat.db')});
      chat.init(asyncCb);
    },

    // get game data
    game: function(asyncCb)
    {
      game = new Game({storage: path.join(dataPath, 'game.db')});
      game.init(asyncCb);
    }
  }, function(err)
  {
    if (err) return callback(err);

    callback(null);
  });
}

// }}}
