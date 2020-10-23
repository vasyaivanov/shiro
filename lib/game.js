var _     = require('lodash')
  , level = require('level')
  , redis = require('ioredis')
  , redisScan = require('redisscan')
  , async = require('async')
  , merge = require('deeply')

  // local
  , unidecode = require('./unidecode')

  // token
  , token =
    { meta    : 'meta'
    , team    : 'team'
    , state   : 'state'
    , question: 'question'
    }

  , templateTeam =
    { login     : ''
    , name      : ''
    , password  : ''
    , online    : false
    , points    : 0
    , time_bonus: 0
    , dollars: 0
    , adjustment: 0
    , visibility: false
    , answers   : {}
    }

  , templateQuestion =
    { index : 0
    , text  : ''
    , answer: ''
    , vabank: false
    , played: false
    }


  // globals
  , admin     = {} // admin socket.id back reference
  , teams     = {} // teams socket.id back reference
  // making sense to state
  , toBeAdmin = {} // keeps reference to the sockets claimed to be an admin
  , toBeTeam  = {} // keeps reference to the sockets claimed to be a team
  ;

module.exports = Game;

function Game(options)
{
  // environment
  this._env = options.env || function(){};

  // db file
  this._storage = options.storage;

  // db instance
  this._db = undefined;

  // redis instance
  this._redis = undefined;

  // meta data
  this.meta = {};
  // list of teams
  this.team = {};
  // questions (with answers)
  this.question = {};

  // dirty work
  this._timerCountdown = this._timerCountdownStub.bind(this);
}

Game.prototype.init = function Game_init(callback)
{
  var _game = this
    , now
    , initCallback = callback
    ;


  // connect to redis db
  console.log("JD: Redis URL = " + process.env.REDIS_URL);
  if(process.env.REDIS_URL != undefined) {
    this._redis = new redis(process.env.REDIS_URL);
    // this._redis = redis.createClient(process.env.REDIS_URL);
  } else {
    this._redis = new redis(6379, "127.0.0.1");
    // this._redis = redis.createClient({ host:'127.0.0.1', port:6379});
  }

  // get stuff from redis on connection
  this._redis.on('connect', function(err) {

    console.log("Connected to redis! err=" + err);
    if (err) {
      console.log("JD: Error connecting to redis!" + err);
      return callback(err);
    }

    _game._db = _game._redis;


  try{
      async.series(
      { meta    : _game._fetchSlice.bind(_game, token.meta)
      , team    : _game._fetchSlice.bind(_game, token.team)
      , state   : _game._fetchSlice.bind(_game, token.state)
      , question: _game._fetchSlice.bind(_game, token.question)
      }, function(err, res)
      {
        if (err) return callback(err);

        _game.meta     = res.meta;
        _game.state    = res.state;
        // filter it thru template object
        for(teamLogin in res.team)
        {
          var team = res.team[teamLogin];
          if(team && team.login) {
            _game.team[team.login] = team;
          }
        }

        // _game.team     = _.each(res.team, function(team, key)
        //   { res.team[key] = merge(templateTeam, team); }) && res.team;


        _game.question = _.each(res.question, function(question, key){ res.question[key] = merge(templateQuestion, question); }) && res.question;

        // keep state sane
        if (_game.state['current_question'] && !_game.question[_game.state['current_question']])
        {
          _game.state['current_question'] = false;
          _game.state['display'] = false;
        }

        // check for ongoing timer
        if (_game.state.timer)
        {
          // and start it again
          _game._startTimerCountdown();
          _game._showQuestion();
        }

        // {{{ create game instance id
        // to prevent user name collisions
        // after db reset
        if (!_game.meta.instance)
        {
          console.log("JD: !_game.meta.instance");
          now = process.hrtime();

          _game.save('meta', 'instance', Date.now().toString(36) + now[1].toString(36) + now[0].toString(36), initCallback);
        }
        else
        {
          try{
            initCallback(null);
          } catch (err) {
            console.log("JD: could not call callback err=" + err);
          }
        }
      });
  } catch (err) {
    console.log("JD: error in asyn in Game init. err=" + err);
  }

  });

  // level(this._storage, {keyEncoding: 'utf8', valueEncoding: 'json'}, function(err, db)
  // {

  // });


  // set event listeners
  this._initEventListeners();
}

// saves data to db
Game.prototype.save = function Game_save(channel, key, value, callback)
{
  var _game = this;
  var redisKey = token[channel]+':'+key;
  var redisValue = undefined;
  redisValue = _game._convertToRedisString(value);

  this._redis.set(redisKey, redisValue, function(err)
  {
    var log = {};

    if (err) return callback(err);

    // console.log is the best backup/aof
    log[token[channel]+':'+key] = value;
    console.log(JSON.stringify(log));

    // update local
    _game[channel][key] = value;

    return callback(null);
  });
}

// loads data from db
Game.prototype.load = function Game_load(channel, key, callback)
{
  var _game = this;
  var redisKey = token[channel]+':'+key;

  this._redis.get(redisKey, function(err, value)
  {
    if (err)
    {
      // reset local
      if (key in _game[channel])
      {
        delete _game[channel][key];
      }

      if (err.notFound)
      {
        return callback(null, undefined);
      }

      return callback(err);
    }

    value = _game._convertFromRedisString(value);

    // update local
    _game[channel][key] = value;

    return callback(null, value);
  });
}

// deletes data from db
Game.prototype.delete = function Game_delete(channel, key, callback)
{
  var _game = this;

  this._redis.del(token[channel]+':'+key, function(err)
  {
    if (err) return callback(err);

    // update local
    delete _game[channel][key];

    return callback(null);
  });
}

// authenticates as admin or team user
Game.prototype.auth = function Game_auth(user, callback)
{
  var _game = this
    , info
    , userData
    ;

  if (!user.login || !user.password) return callback({code: 400, message: 'Missing data.'});


  if (user.login == 'admin')
  {
    if (this._env('admin') != user.password) return callback({code: 400, message: 'Wrong password.'});

    userData = {login: 'admin', password: user.password};
    userData.socketid = user.socketid;

    // store temporarily
    admin[user.socketid] = userData;
  }
  else if (this.team[user.login])
  {
    if (this.team[user.login].password != user.password) return callback({code: 400, message: 'Wrong team/password combination.'});

    // set online flag
    this.team[user.login].online = true;

    userData = this.team[user.login];
    userData.socketid = user.socketid;

    // store temporarily
    teams[user.socketid] = userData;
  }
  else
  {
    return callback({code: 401, message: 'Could not recognize provided login.'});
  }

  // done here, no need to save it here
  // since after restart socketid and online:true flag
  // would useless and wrong
  callback(null, userData);
}

// cleans up disconnected user
Game.prototype.left = function Game_left(user, callback)
{
  var _game = this
    , info
    , userData
    ;

  if (!user.socketid)
  {
    return callback({code: 400, message: 'Missing data.', wtf: user});
  }

  // cleanup
  delete toBeAdmin[user.socketid];
  delete toBeTeam[user.socketid];

  if (teams[user.socketid])
  {
    info  = 'team';
    // get team data object
    userData = this.team[teams[user.socketid].login];
    // cleanup user object
    delete teams[user.socketid];
  }
  else if (admin[user.socketid])
  {
    info  = 'meta';
    // get admin data object
    userData = this.meta['admin'] || _.omit(admin[user.socketid], 'socketid');
    // cleanup user object
    delete admin[user.socketid];
  }
  else
  {
    // whatever
    return callback(null, {});
  }

  // if team was deleted here is no traces of it
  if (!userData) return callback(null, {});

  // kill online flag
  userData.online = false;

  // resave
  this.save(info, userData.login, userData, function(err)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, userData);
  });
}

// Attaches reference to known external objects
Game.prototype.attach = function Game_attach(collection)
{
  // chat reference
  if ('chat' in collection)
  {
    this._chat = collection['chat'];
  }

  // websockets reference
  if ('sockets' in collection)
  {
    this._sockets = collection['sockets'];
  }
}

// Sets timer on/off
Game.prototype.setTimer = function Game_setTimer(timer, callback)
{
  var _game = this
    , timerData
    ;

  if (!timer)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (timer == 'on' && this.state['timer'])
  {
    return callback({code: 400, message: 'Timer has already started.'});
  }
  else if (timer == 'off' && !this.state['timer'])
  {
    // return callback({code: 400, message: 'No timer to turn off.'});
  }

  if (timer == 'off')
  {
    timerData = false;

    // kill countdown
    if (this.state['timer'].countdown)
    {
      clearInterval(this.state['timer'].countdown);
    }
  }
  else
  {
    timerData = { start: process.hrtime() };
  }

  // save
  this.save('state', 'timer', timerData, function(err)
  {
    if (err) return callback({code: 500, message: err});

    // start timer countdown
    if (timerData)
    {
      _game._startTimerCountdown();
      _game._showQuestion();
    }

    return callback(null, timerData);
  });
}

function calculateTotalDollarsForTeam(updatedTeam)
{
  var totalDollars = 0;
  if(updatedTeam && updatedTeam.answers)
  {
    var answers = updatedTeam.answers;
    for(answerNumber in answers)
    {
      if(answers[answerNumber].dollars)
      {
        totalDollars += answers[answerNumber].dollars;
      }
    }
  }
  return totalDollars;
}

function calculateDollars(myTeamData, _game, questionNumber, isStatusAdjustment) 
{
      var teamsWithUpdatedDollars = {}; 


      var teams = _game.team;
      var numberOfTeams = 0;
      var numberOfCorrectAnswers = 0;
      if(teams){
        for (team in teams)
        {
          numberOfTeams += 1;
          var teamData = teams[team];
          var answers = teamData.answers;
          try {
            var answer = _game.team[teamData.login].answers[questionNumber]; 
            if(answer && answer.correct)
            {
              if(team == myTeamData.login) {
                teamsWithUpdatedDollars[myTeamData.login] = myTeamData;
              } else {
                teamsWithUpdatedDollars[teamData.login] = teamData;
              }
              numberOfCorrectAnswers += 1;
            }
          } catch {
            // do nothing, team does not have answer for that question
          }
        }
      }

      var dollars = 0;
      if(numberOfCorrectAnswers || isStatusAdjustment) 
      {
        if(numberOfCorrectAnswers) {
          dollars = Math.floor(numberOfTeams / numberOfCorrectAnswers);
        } 

        if(isStatusAdjustment) {
          teamsWithUpdatedDollars[myTeamData.login] = myTeamData;
        }

        for(updatedTeamName in teamsWithUpdatedDollars)
        {
          var updatedTeam = teamsWithUpdatedDollars[updatedTeamName];

          if(updatedTeam.login == myTeamData.login && !myTeamData.answers[questionNumber].correct) {
            updatedTeam.answers[questionNumber].dollars = 0;
          } else {
            updatedTeam.answers[questionNumber].dollars = dollars;
          }
          updatedTeam.dollars = calculateTotalDollarsForTeam(updatedTeam);

          if(updatedTeam.answers[questionNumber].vabank) {
            updatedTeam.dollars = updatedTeam.dollars * 2;
          }

          _game.team[updatedTeam.login].answers[questionNumber].dollars = dollars;
          _game.team[updatedTeam.login].dollars = updatedTeam.dollars;
          // console.log("JD: updating dollars in _game.team["+updatedTeam.login+"].answer=" + _game.team[updatedTeam.login].answers[questionNumber].dollars);
          // console.log("JD: updating dollars in _game.team["+updatedTeam.login+"]=" + _game.team[updatedTeam.login].dollars);

        }
      }
      // myTeamData.dollars = dollars + Number(myTeamData.dollars);
      return teamsWithUpdatedDollars;
}

// Evals team's answer
Game.prototype.evalAnswer = function Game_evalAnswer(data, isStatusAdjustment, callback)
{
  var _game = this;

  if (!data.question || !data.team || (data.status==null))
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  var correctFlag = data.status;
  var teamData = this.team[data.team];

  // if (!(teamData = this.team[data.team]))
  // {
  //   return callback({code: 404, message: 'Team '+data.team+' does not exist.'});
  // }

  if (!teamData.answers[data.question])
  {
    return callback({code: 404, message: 'Team '+data.team+' does not have answer for the question #'+data.question+'.'});
  }

  // set correct flag
  teamData.answers[data.question].correct = data.status;

  // update points
  teamData = this._recalculatePoints(teamData);

  var teamsWithUpdatedDollars = undefined;
  if(correctFlag || isStatusAdjustment)
  {

    teamsWithUpdatedDollars = calculateDollars(teamData, _game, data.question, isStatusAdjustment);
    teamData = teamsWithUpdatedDollars[teamData.login];

    var pipeline = this._redis.pipeline();
    for (updatedTeamLogin in teamsWithUpdatedDollars)
    {
      var updatedTeam = teamsWithUpdatedDollars[updatedTeamLogin];
      // console.log("JD: saving in redis updated team: " + updatedTeamLogin + " dollars: " + teamsWithUpdatedDollars[updatedTeamLogin].dollars);
      // console.log("JD: saving in _game updated team: " + updatedTeamLogin + " dollars: " + _game.team[updatedTeamLogin].dollars);
      pipeline.set('team:'+updatedTeamLogin, _game._convertToRedisString(updatedTeam));
      _game['team'][updatedTeamLogin] = updatedTeam;

      // redisMulti = redisMulti.set('team:'+updatedTeam, teamsWithUpdatedDollars[updatedTeam]);
    }
    pipeline.exec(callback(null, teamsWithUpdatedDollars, _game));
    // redisMulti.exec(function() {
    //   console.log("JD: executed redis save updated teams");
    //   callback(null, teamData, _game);
    // });

  } else {

    this.save('team', teamData.login, teamData, function(err)
    {
      console.log("JD: answer is incorrect and saving team as it is");
      if(data.vabank) {
        teamData.dollars = 0;
      }
      if (err) return callback({code: 500, message: err}, null, _game);
      var updatedTeams = {};
      updatedTeams[teamData.login] = teamData;
      return callback(null, updatedTeams, _game);
    });

  }

  // var teamsWithUpdatedDollars = undefined;
  // if(correctFlag)
  // {
  //   teamsWithUpdatedDollars = calculateDollars(teamData, _game, data.question);
  //   // teamData.dollars = calculateDollars(teamData, _game, data.question);
  //   if(teamsWithUpdatedDollars)
  //   {
  //     for(updatedTeam in teamsWithUpdatedDollars)
  //     {
  //       var updatedTeamData = teamsWithUpdatedDollars[updatedTeam];
  //       this.save('team', updatedTeamData.login, updatedTeamData, function(err)
  //       {
  //         if (err) return callback({code: 500, message: err}, null, _game);

  //         // send different data to the admin and to others
  //         _.each(_game._sockets.connections, function(s, id)
  //         {
  //           s.write({ 'game:team_updated': _game._teamStripAnswers(id, team) });
  //         });

  //         // _game.addAnswer(updatedTeamData.login, updatedTeamData);

  //         return callback(null, updatedTeamData, _game);
  //       });
  //     }
  //   }
  // }
}

//check answer
function testIfAnswerIsCorrect(teamAnswer, correctAnswer, correctRegex) {
  isAnswerCorrect = false;
  if(!teamAnswer || !correctAnswer) {
    return false;
  }

  teamAnswer = teamAnswer.trim().toLowerCase();

  //Regex answer
  if(teamAnswer === correctAnswer) {
    isAnswerCorrect = true;
  }
  else if(correctRegex) {
    try {
      isAnswerCorrect = (new RegExp(correctRegex)).test(teamAnswer);
    } catch (err) {
      console.log("Could not parse regular expression." + err.message);
    }
  }
  return isAnswerCorrect;
}

// Record answer from a team
Game.prototype.addAnswer = function Game_addAnswer(data, callback)
{
  var _game = this
    , diff
    , timeBonus
    , dollars
    , timer
    , question
    , teamData
    ;

  if (!data.login || typeof data.answer != 'object' || !('text' in data.answer))
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!(teamData = this.team[data.login]))
  {
    return callback({code: 404, message: 'Team '+data.login+' does not exist.'});
  }

  if (!(timer = this.state['timer']) || !(question = this.state['current_question']))
  {
    //return callback({code: 403, message: 'Answers accepted only during minute countdown.'});
    return callback({code: 403, message: 'Please submit your answers on time next time :)'});
  }

  if (teamData.answers && teamData.answers[question])
  {
    return callback({code: 403, message: 'Only one answer per question is allowed.'});
  }

  // calculate time difference
  diff = process.hrtime(timer.start);
  timeBonus = 70000 - (diff[0] * 1000 + Math.floor(diff[1] / 1e6)); // was 60000
  // convert from milliseconds to seconds
  timeBonus = Math.floor(timeBonus / 1000);

  // add answer
  teamData.answers[question] = {text: data.answer.text, time: diff, bonus: timeBonus, dollars: dollars, vabank: data.answer.vabank, correct: null};


  _game.getQuestion({index: _game.state["current_question"]}, function Game_getQuestionAnswerCallback(err, question)
  {
      console.log("\n\n\nJD:answer="+question+"\n\n\n");
      var teamAnswer = '';
      var questionNumber = _game.state["current_question"];
      try{
        teamAnswer = teamData.answers[questionNumber].text;
      } catch (err) {
        console.log("Could not fetch answer for a team. " + err.message);
      }
      if(!err && question && teamData && teamData.answers){
        
        
        
        //Eval if answer is correct
        var isAnswerCorrect = testIfAnswerIsCorrect(teamAnswer,question.answer, question.regex);
        teamData.answers[questionNumber].correct = false;
        if(isAnswerCorrect) {
          try{
            teamData.answers[questionNumber].correct = true;
          } catch (err) {
            console.log("Could not assign answer to be correct for a team. " + err.message);
          }
        }

        var data = new Object();
        data.question = questionNumber;
        data.team=teamData.login;
        data.status=teamData.answers[questionNumber].correct;
        if(_game.question[questionNumber] && _game.question[questionNumber].vabank) {
          data.vabank=teamData.answers[questionNumber].vabank;
        } else {
          data.vabank = false;
        }
        _game.evalAnswer(data, false, function(err,updatedTeams,game){
            return callback(null, updatedTeams);
            // // save
            // game.save('team', teamData.login, teamData, function(err)
            // {
            //   console.log("JD: saving team again name: " + teamData.login + " dollars: " + teamData.dollars);
            //   if (err) return callback({code: 500, message: err});
            //   return callback(null, teamData);
            // });
        });
      }
  });
}

// // Evals team's answer
// Game.prototype.evalAnswer = function Game_evalAnswer(data, callback)
// {
//   var _game = this
//     , teamData
//     ;

//   if (!data.question || !data.team || !data.status)
//   {
//     return callback({code: 400, message: 'Missing data.'});
//   }

//   if (!(teamData = this.team[data.team]))
//   {
//     return callback({code: 404, message: 'Team '+data.team+' does not exist.'});
//   }

//   if (!teamData.answers[data.question])
//   {
//     return callback({code: 404, message: 'Team '+data.team+' does not have answer for the question #'+data.question+'.'});
//   }

//   // set correct flag
//   teamData.answers[data.question].correct = data.status == 'correct' ? true : false;

//   // update points
//   teamData = this._recalculatePoints(teamData);

//   // save
//   this.save('team', teamData.login, teamData, function(err)
//   {
//     if (err) return callback({code: 500, message: err});
//     return callback(null, teamData);
//   });
// }

// Adds new team
Game.prototype.addTeam = function Game_addTeam(team, callback)
{
  var _game = this
    , teamData
    ;

  if (!team.login || !team.name || !team.password)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (this.team[team.login])
  {
    return callback({code: 400, message: 'Team '+team.login+' already exists.'});
  }

  // create team data
  teamData = merge(templateTeam, {login: team.login, name: team.name, city: team.city, password: team.password});

  // save
  this.save('team', teamData.login, teamData, function(err)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, teamData);
  });
}

// Updates existing team
Game.prototype.updateTeam = function Game_updateTeam(team, callback)
{
  var _game = this
    , teamData
    ;

  if (!team.login)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!this.team[team.login])
  {
    return callback({code: 404, message: 'Team '+team.login+' does not exist.'});
  }

  // calculate adjustment
  if ('points' in team)
  {
    team.adjustment = this.team[team.login].adjustment + (+(team.points || 0) - this.team[team.login].points );
  }

  // if answers changes recalculate points
  if ('answers' in team)
  {
    team = this._recalculatePoints(team);
  }

  // deep merge team data
  teamData = merge(this.team[team.login], team);

  // save
  this.save('team', teamData.login, teamData, function(err)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, teamData);
  });
}

// Deletes existing team
Game.prototype.deleteTeam = function Game_deleteTeam(team, callback)
{
  var _game = this
    , teamData
    ;

  if (!team.login)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!this.team[team.login])
  {
    return callback({code: 404, message: 'Team '+team.login+' does not exist.'});
  }

  // last reference to the team data
  teamData = this.team[team.login];

  // delete
  this.delete('team', teamData.login, function(err)
  {
    var team;

    if (err) return callback({code: 500, message: err});

    // delete user from chat
    _game._chat.deleteUser('_team_'+teamData.login, function(){/* whatever */});

    // kick deleted team out
    if ((team = _.find(teams, {login: teamData.login})) && team.socketid)
    {
      _game._sockets.connections[team.socketid].write({ 'you:action': 'refresh' });
    }

    return callback(null, teamData);
  });
}

// --- Questions

// Sets current question (in play)
Game.prototype.setQuestion = function Game_setQuestion(question, callback)
{
  var _game = this
    , questionData
    ;

  if (!('index' in question))
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (question.index && !this.question[question.index])
  {
    return callback({code: 404, message: 'Question '+question.index+' does not exist.'});
  }

  if (this.state['current_question'] == question.index)
  {
    if (question.index)
    {
      return callback({code: 400, message: 'Question '+question.index+' is already in play.'});
    }
    else
    {
      return callback({code: 400, message: 'No question to unset.'});
    }
  }

  // mark previous question as played, if answer for the question been shown
  if (this.state['current_question'] && this.question[this.state['current_question']] && this.question[this.state['current_question']].answer_shown)
  {
    this.updateQuestion({index: this.state['current_question'], played: true}, function Game_setQuestion_updateQuestion_callback(err, prevQuestion)
    {
      if (err) return console.log(['Could not update current question', err, _game.state['current_question']]);
      _game._sockets.write({ 'game:question_updated': _.omit(prevQuestion, ['text', 'answer']) });
    });
  }

  // reset displayed questions
  this._showQuestion(false);

  // get question data or null
  questionData = question.index ? this.question[question.index] : {index: false};

  // save
  this.save('state', 'current_question', questionData.index, function(err)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, questionData);
  });
}

// Adds new question
Game.prototype.addQuestion = function Game_addQuestion(data, callback)
{
  var _game = this
    , questionData
    ;

  if (!data.text || !data.answer)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  // create team data
  questionData = {vabank: data.vabank, prequestion: data.prequestion, text: data.text, answer: data.answer, regex: data.regex};

  // add index
  questionData.index = _.keys(this.question).length + 1;

  // save
  this.save('question', questionData.index, questionData, function(err)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, questionData);
  });
}

// Updates existing question
Game.prototype.updateQuestion = function Game_updateQuestion(question, callback)
{
  var _game = this
    , questionData
    ;

  if (!question.index)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!this.question[question.index])
  {
    return callback({code: 404, message: 'Question '+question.index+' does not exist.'});
  }

  // reset answer_shown along with played
  if (this.question[question.index].played && question.played === false)
  {
    question.answer_shown = false;
  }

  // deep merge team data
  questionData = merge(this.question[question.index], question);

  // save
  this.save('question', questionData.index, questionData, function(err)
  {
    if (err) return callback({code: 500, message: err});

    // update currently displaying question
    if (_game.state['display'] && _game.state['display'].question && _game.state['display'].question.index == questionData.index)
    {
      // refresh displayed question
      _game._showQuestion();
    }

    return callback(null, questionData);
  });
}

// Deletes existing question
Game.prototype.deleteQuestion = function Game_deleteQuestion(question, callback)
{
  var _game = this
    , questionData
    ;

  if (!question.index)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!this.question[question.index])
  {
    return callback({code: 404, message: 'Question '+question.index+' does not exist.'});
  }

  // last reference to the question data
  questionData = this.question[question.index];

  // delete
  this.delete('question', questionData.index, function(err)
  {
    if (err) return callback({code: 500, message: err});

    // reset current question
    if (_game.state['current_question'] == questionData.index)
    {
      // reset displayed questions
      _game._showQuestion(false);
      // reset current question
      _game.state['current_question'] = false;
      _game._sockets.write({ 'game:current_question': {index: false} });
    }

    // update teams
    async.eachSeries(_.values(_game.team), function(team, cb)
    {
      // remove deleted question
      if (team.answers && team.answers[questionData.index])
      {
        delete team.answers[question.index];

        // update points
        team = _game._recalculatePoints(team);

        // update team source
        _game.updateTeam(_.pick(team, ['login', 'points', 'time_bonus', 'dollars', 'answers']), function(err, teamData)
        {
          if (err) return cb(err);

          // update team upstream
          // send different data to the admin and to others
          _.each(_game._sockets.connections, function(s, id)
          {
            s.write({ 'game:team_updated': _game._teamStripAnswers(id, teamData) });
          });

          cb(null);
        });
      }
      else
      {
        cb();
      }

    }, function(err)
    {
      if (err) return callback(err);

      return callback(null, questionData);
    });

  });
}

Game.prototype.resetScoreboard = function Game_resetScoreboard(callback)
{
  var _game = this;
  this._resetAll(callback);

  // // reset teams' answers, current state and questions' played flags
  // async.series(
  // { teams    : _game._resetTeams.bind(this)
  // , state    : _game._resetState.bind(this)
  // , questions: _game._resetQuestions.bind(this)
  // }, function(err, res)
  // {
  //   if (err) return callback(err);

  //   callback(null);
  // });
}

// Fetches question data
Game.prototype.getQuestion = function Game_getQuestion(question, callback)
{
  var _game = this
    ;

  if (!question.index)
  {
    return callback({code: 400, message: 'Missing data.'});
  }

  if (!this.question[question.index])
  {
    return callback({code: 404, message: 'Question '+question.index+' does not exist.'});
  }

  // fetch
  this.load('question', question.index, function(err, questionData)
  {
    if (err) return callback({code: 500, message: err});
    return callback(null, questionData);
  });
}

Game.prototype._recalculatePoints = function Game__recalculatePoints(team)
{
  // update total time_bonus
  team['time_bonus'] = _.reduce(team.answers, function(bonus, answer)
  {
    return answer.correct ? bonus + (answer.bonus || 0) : +(bonus || 0);
  }, 0);

  // update total points
  team.points = _.reduce(team.answers, function(points, answer)
  {
    return answer.correct ? points+1 : +points;
  }, 0);

  // apply adjustment
  team.points += team.adjustment;

  return team;
}

// --- Reset subroutines

Game.prototype._resetTeams = function Game__resetTeams(callback)
{
  var _game   = this
    , channel = 'team'
    , ops     = []
    , key
    , redisMulti = this._redis.multi();
    ;

  for (key in this.team)
  {
    this.team[key] = _.merge(this.team[key], {points: 0, time_bonus: 0, dollars: 0, adjustment: 0});
    // since merge is deep, make it dead simple
    this.team[key].answers = {};
    //ops.push({type: 'put', key: token[channel]+':'+key, value: this.team[key]});
    redisMulti = redisMulti.set(token[channel]+':'+key, this.team[key]);
  }
  redisMulti.exec(function (callback) {
    console.log("JD: TEAMS has been reset");
    callback()
  } );

  // update
  //this._db.batch(ops, callback);
}

Game.prototype._resetState = function Game__startTimerCountdown(callback)
{
  var _game   = this
    , channel = 'state'
    , ops     = []
    , key
    , redisMulti = this._redis.multi();
    ;

  for (key in this.state)
  {
    this.state[key] = false;
    // ops.push({type: 'put', key: token[channel]+':'+key, value: false});
    redisMulti = redisMulti.set(token[channel]+':'+key, false);
  }

  // update
  // this._db.batch(ops, callback);
  redisMulti.exec(function (callback) {
    console.log("JD: TEAMS has been reset");
    callback()
  } );
}

Game.prototype._resetQuestions = function Game__startTimerCountdown(callback)
{
  var _game   = this
    , channel = 'question'
    , ops     = []
    , key
    , redisMulti = this._redis.multi();

    ;

  for (key in this.question)
  {
    this.question[key] = _.merge(this.question[key], {played: false, answer_shown: false});
    //ops.push({type: 'put', key: token[channel]+':'+key, value: this.question[key]});
    redisMulti = redisMulti.set(token[channel]+':'+key, this.question[key]);
  }

  // update
  // this._db.batch(ops, callback);
  redisMulti.exec(callback);
}

// --- Internal logic lives here

// starts countdown interval counter
Game.prototype._startTimerCountdown = function Game__startTimerCountdown()
{
  this.state['timer'].countdown = setInterval(this._timerCountdown, 333); // three times a second should be precise enough
  // and start it already
  setTimeout(this._timerCountdown, 0);
}

Game.prototype._timerCountdownStub = function Game__timerCountdown()
{
  var _game = this;

  var diff = process.hrtime(this.state['timer'].start);

  if (this._sockets)
  {
    this._sockets.write({'game:timer': {tick: diff[0], nano: diff[1]} });
  }

  // check the limits
  if (diff[0] >= 70) // was 60 originally
  {
    // turn off timer
    this.setTimer('off', function Game_setTimer_off_callback(err, timer)
    {
      if (err) return console.log(['Could not set timer off from countdown interval', err]);

      _game._sockets.write({'game:timer': false });
    });
  }
}

// display current question
Game.prototype._showQuestion = function Game__showQuestion(show)
{
  var _game = this
    , displayData
    ;

  if (arguments.length < 1)
  {
    show = true;
  }

  // check if current question is selected
  if (!show || !this.state['current_question'] || !this.question[this.state['current_question']])
  {
    displayData = false;
  }
  else
  {
    // get question without answer
    displayData = {question: _.omit(this.question[this.state['current_question']], 'answer')};
  }

  // save
  this.save('state', 'display', displayData, function(err)
  {
      if (err) return console.log(['Could not set current question to display', err]);

      _game._sockets.write({'game:display': displayData });
  });
}

// display current question
Game.prototype._showAnswer = function Game__showAnswer(show)
{
  var _game = this
    , displayData
    ;

  if (arguments.length < 1)
  {
    show = true;
  }

  // check if current question is selected
  if (!show || !this.state['current_question'] || !this.question[this.state['current_question']])
  {
    displayData = false;
  }
  else
  {
    // get question with answer
    displayData = { answer: this.question[this.state['current_question']] };
  }

  // save
  this.save('state', 'display', displayData, function(err)
  {
      if (err) return console.log(['Could not set answer to display', err]);

      // mark answer as shown
      if (displayData)
      {
        _game.updateQuestion({index: displayData.answer.index, answer_shown: true}, function Game__showAnswer_updateQuestion_callback(err, question)
        {
          if (err) console.log(['Could not update current question from answer', err, displayData]);
        });
      }

      _game._sockets.write({'game:display': displayData });
  });
}

// Sends current state to the socket
// hides some data based on the access level
Game.prototype._sendState = function Game__sendState(socket)
{
  // if no specific socket - broadcast
  if (!socket)
  {
    _.each(this._sockets.connections, this._sendState.bind(this));
    return;
  }

  // send initial data to the requesting socket
  socket.write(
  {
    game:
    { instance : this.meta.instance
      // don't expose password and answers
      // and it's ok to show answers to admins
    , teams    : _.map(this.team, _.partial(this._teamStripAnswers, socket.id))
    , questions: _.map(this.question, function(question){ return _.omit(question, ['text', 'answer']); })
    , state    : _.transform(this.state, function(result, item, key){ result[key] = (item && key == 'timer' ? _.omit(item, 'countdown') : item); })
    }
  });
}

// Strips sensitive information from team data
// but leaves it for admins
Game.prototype._teamStripAnswers = function Game__teamStripAnswers(socketId, team)
{
  return _.transform(team, function(result, item, key)
  {
    if (key == 'password' || key == 'socketid') return;

    result[key] = typeof item != 'object'
      ? item
      : _.transform(item, function(result, item, key)
        {
          result[key] = admin[socketId]
            ? item
            : _.omit(item, 'text');
        });
  });
}

// sets event listeners
// Note: all the event handlers bound to primus (websockets) object
Game.prototype._initEventListeners = function Game__initEventListeners()
{
  var _game = this;

  this.events = {};

  // [helo] initial handshake
  this.events['helo'] = function Game__initEventListeners_helo(socket, data)
  {
    // don't talk to anybody else
    if (data != 'game' && data != 'team' && data != 'admin') return;

    // if it's team or admin ask to auth
    if (data == 'team' || data == 'admin')
    {
      if (data == 'admin')
      {
        toBeAdmin[socket.id] = socket;
      }
      else
      {
        toBeTeam[socket.id] = socket;
      }

      socket.write({'game:auth': {type: data, instance: _game.meta.instance} });
    }
    else
    {
      _game._sendState(socket);
    }
  };

  // [disconnection]
  this.events['disconnection'] = function Game__initEventListeners_disconnection(socket)
  {
    var _sockets = this;

    _game.left(
    {
      socketid: socket.id
    }, function Game_left_callback(err, user)
    {
      if (err) return console.log({ 'game:error': {err: err, origin: 'disconnection', data: user} });

      // if it's regular spectator don't raise a fuss
      if (user.login)
      {
        _sockets.write({ 'game:left': {login: user.login} });
      }
    });
  };

  // [game:auth]
  this.events['game:auth'] = function Game__initEventListeners_game_auth(socket, data)
  {
    var _sockets = this
      , nickname
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    // check if user isn't rude and said helo beforehand
    if (data.login == 'admin' && !toBeAdmin[socket.id])
    {
      return socket.write({ 'game:error': {err: {code: 401, message: 'Could not recognize provided login.'}, origin: 'auth'} });
    }
    else if (data.login != 'admin' && !toBeTeam[socket.id])
    {
      // return socket.write({ 'game:error': {err: {code: 401, message: 'Could not recognize provided login.'}, origin: 'auth'} });
    }

    // clean up
    delete toBeAdmin[socket.id];
    delete toBeTeam[socket.id];

    _game.auth(
    {
      login   : data.login,
      password: data.password,
      socketid: socket.id
    }, function Game_auth_callback(err, user)
    {
      if (err) return socket.write({ 'game:error': {err: err, origin: 'auth', data: data} });

      if (user.login == 'admin')
      {
        _sockets.write({ 'game:admin': {login: user.login} });
        nickname = '_admin_'+user.login;
      }
      else
      {
        _sockets.write({ 'game:team': {login: user.login, name: user.name} });
        nickname = '_team_'+user.login;
      }

      socket.write({ 'game:logged': {login: user.login, password: user.password} });

      // Auto-login into chat as game user
      if (_game._chat)
      {
        _game._chat.forceJoin(_sockets, socket, {nickname: nickname, password: data.password});
      }

      // send state
      _game._sendState(socket);
    });
  };

  // --- team events

  // [team:visibility]
  this.events['team:visibility'] = function Game__initEventListeners_team_visibility(socket, data)
  {
    var _sockets = this
      , login
      ;

    if (typeof data != 'boolean')
    {
      // it's something like I don't know
      return;
    }

    if (!(login = _game._isTeam(socket, 'visibility')))
    {
      return;
    }

    _game.updateTeam({login: login, visibility: !!data}, function Game_teamVisibility_updateTeam_callback(err, team)
    {
      if (err) return socket.write({ 'team:error': {err: err, origin: 'visibility'} });
      _sockets.write({ 'team:visibility': {team: team.login, visibility: team.visibility} });
    });
  };

  // [team:answer]
  this.events['team:answer'] = function Game__initEventListeners_team_answer(socket, data)
  {
    console.log("/n/nJD: in team:answer/n/n");
    var _sockets = this
      , login
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!(login = _game._isTeam(socket, 'answer')))
    {
      return;
    }

    _game.addAnswer({login: login, answer: data}, function Game_addAnswer_callback(err, updatedTeams)
    {
      if (err) return socket.write({ 'team:error': {err: err, origin: 'answer'} });

      // send different data to the admin and to others
      _.each(_sockets.connections, function(s, id)
      {
        for(team in updatedTeams) 
        {
          // console.log("JD: 2 SENDING TO SOCKET:" + id + " team:" + team.login + " dollars:" + team.dollars);
          s.write({ 'game:team_updated': _game._teamStripAnswers(id, updatedTeams[team]) });
        }
      });

    });
  };

  this.events['team:vabank'] = function Game__initEventListeners_team_vabank(socket, data)
  {
    console.log("\n\nVABANK WAS CHECKED: team: "+data.team+" clicked vabank: " + data.vabank);
    //_game._sockets.connections[team.socketid].write({ 'you:action': 'refresh' });
  }

  // mp3 (not really related to the game, just remote mp3 player)
  this.events['mp3'] = function Game__initEventListeners_mp3(socket, data)
  {
    var _sockets = this;
    console.log("JD: MP3 PAUSE! data="+data);
    if(data == "pause") {
      _sockets.write({ 'mp3' : 'pause'});
    } else if (data == "play") {
      _sockets.write({ 'mp3' : 'play'});

    }
  }


  // --- admin stuff

  // [admin:eval_answer]
  this.events['admin:eval_answer'] = function Game__initEventListeners_admin_eval_answer(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'eval_answer'))
    {
      return;
    }

    // convert status from word 'correct' to boolean true/false
    data.status = (('correct'==data.status) ? true : false  );

    _game.evalAnswer(data, true, function Game_evalAnswer_callback(err, updatedTeams, game)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'eval_answer', data: data} });

      // send different data to the admin and to others
      _.each(_sockets.connections, function(s, id)
      {
        for(team in updatedTeams) 
        {
          s.write({ 'game:team_updated': _game._teamStripAnswers(id, updatedTeams[team]) });
          // s.write({ 'game:team_updated': _game._teamStripAnswers(id, team) });
        }
      });

    });
  };

  // [admin:set_timer]
  this.events['admin:set_timer'] = function Game__initEventListeners_admin_set_timer(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'set_timer'))
    {
      return;
    }

    _game.setTimer(data, function Game_setTimer_callback(err, timer)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'set_timer', data: data} });
      _sockets.write({ 'game:timer': timer });
    });
  };

  // [admin:set_question]
  this.events['admin:set_question'] = function Game__initEventListeners_admin_set_question(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'set_question'))
    {
      return;
    }

    _game.setQuestion(data, function Game_setQuestion_callback(err, question)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'set_question', data: data} });
      _sockets.write({ 'game:current_question': _.omit(question, ['text', 'answer','regex']) });
    });
  };

  // [admin:show_answer]
  this.events['admin:show_answer'] = function Game__initEventListeners_admin_show_answer(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'show_answer'))
    {
      return;
    }

    if (!data.index || data.index != _game.state['current_question'])
    {
      socket.write({ 'admin:error': {err: {code: 404, message: 'Cannot display answer for not current question.'}, origin: 'show_answer', data: data} });
      return;
    }

    _game._showAnswer(data.show);
  };

  // [admin:add_team]
  this.events['admin:add_team'] = function Game__initEventListeners_admin_add_team(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'add_team'))
    {
      return;
    }

    _game.addTeam({
      login   : _game._makeHandle(data.name),
      name    : data.name,
      city    : data.city,
      password: data.password
    }, function Game_addTeam_callback(err, team)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'add_team', data: data} });
      _sockets.write({ 'game:team_added': _.omit(team, ['password', 'answers']) });
    });
  };

  // [admin:update_team]
  this.events['admin:update_team'] = function Game__initEventListeners_admin_update_team(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'update_team'))
    {
      return;
    }

    _game.updateTeam(data, function Game_updateTeam_callback(err, team)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'update_team', data: data} });

      // send different data to the admin and to others
      _.each(_sockets.connections, function(s, id)
      {
        s.write({ 'game:team_updated': _game._teamStripAnswers(id, team) });
      });
    });
  };

  // [admin:delete_team]
  this.events['admin:delete_team'] = function Game__initEventListeners_admin_delete_team(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'delete_team'))
    {
      return;
    }

    _game.deleteTeam(data, function Game_deleteTeam_callback(err, team)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'delete_team', data: data} });
      _sockets.write({ 'game:team_deleted': {login: team.login} });
    });
  };

  // --- questions

  // [admin:add_question]
  this.events['admin:add_question'] = function Game__initEventListeners_admin_add_question(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'add_question'))
    {
      return;
    }

    _game.addQuestion(data, function Game_addQuestion_callback(err, question)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'add_question', data: data} });
      _sockets.write({ 'game:question_added': _.omit(question, ['text', 'answer']) });
    });
  };

  // [admin:update_question]
  this.events['admin:update_question'] = function Game__initEventListeners_admin_update_question(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'update_question'))
    {
      return;
    }

    _game.updateQuestion(data, function Game_updateQuestion_callback(err, question)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'update_question', data: data} });
      _sockets.write({ 'game:question_updated': _.omit(question, ['text', 'answer']) });
    });
  };

  // [admin:delete_question]
  this.events['admin:delete_question'] = function Game__initEventListeners_admin_delete_question(socket, data)
  {
    var _sockets = this
      ;

    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'delete_question'))
    {
      return;
    }

    _game.deleteQuestion(data, function Game_deleteQuestion_callback(err, question)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'delete_question', data: data} });
      _sockets.write({ 'game:question_deleted': {index: question.index} });
    });
  };

  // -- special stuff

  // [admin:reset_scoreboard]
  this.events['admin:reset_scoreboard'] = function Game__initEventListeners_admin_reset_scoreboard(socket, data)
  {
    // nothing really, but make it uniform
    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'reset_scoreboard'))
    {
      return;
    }

    _game.resetScoreboard(function Game_resetScoreboard_callback(err)
    {
      if (err) return socket.write({ 'admin:error': {err: err, origin: 'reset_scoreboard'} });

      // refresh the world
      _game._sendState(); // to everybody
    });
  };

  // [admin:get_question]
  // fetches question data and sends it using "callback"
  this.events['admin:get_question'] = function Game__initEventListeners_admin_get_question(socket, data)
  {
    if (!data)
    {
      // it's something like I don't know
      return;
    }

    if (!_game._isAdmin(socket, 'get_question'))
    {
      return;
    }

    _game.getQuestion({index: data.index}, function Game_getQuestion_callback(err, question)
    {
      // perform callback
      socket.write({ '_:callback': {hash: data.callback, err: err, data: merge(templateQuestion, question)} });
    });
  }
}
// --- end of init

// Checks if provided socket is a team
// and return team's login
Game.prototype._isTeam = function Game__isTeam(socket, origin, verbose)
{
  if (arguments < 3)
  {
    verbose = true;
  }

  if (!teams[socket.id])
  {
    verbose && socket.write({ 'team:error': {err: {code: 403, message: 'Permission denied.'}, origin: origin} });
    return false;
  }

  return teams[socket.id].login;
}

// Checks if provided socket is admin
Game.prototype._isAdmin = function Game__isAdmin(socket, origin, verbose)
{
  if (arguments < 3)
  {
    verbose = true;
  }

  if (typeof socket == 'string')
  {
    return !!admin[socket];
  }
  else if (!admin[socket.id])
  {
    verbose && socket.write({ 'admin:error': {err: {code: 403, message: 'Permission denied.'}, origin: origin} });
    return false;
  }

  return true;
}


// --- Santa's little helpers

// fetches slice of data from the database
Game.prototype._fetchSlice = function Game__fetchSlice(slice, callback)
{
  var results = {}
    , sliceRE = new RegExp('^'+slice+'\:')
    , _game = this
    ;

  redisScan({
    redis: this._redis,
    pattern: slice+":*",
    keys_only: false,
    each_callback: function (type, key, subkey, length, value, cb) {
        console.log("Fetching slice:");
        console.log(type, key, subkey, length, value);
        value = _game._convertFromRedisString(value);
        results[key.replace(sliceRE, '')] = value;
        cb();
    },
    done_callback: function (err) {
        console.log("done redis callback");
        callback(null, results);
        // redis.quit();
    }
  });

  // this._db.createReadStream({start: slice+':', end: slice+':~'})
  //   .on('data', function(data)
  //   {
  //     results[data.key.replace(sliceRE, '')] = data.value;
  //   })
  //   .on('error', function(err)
  //   {
  //     callback(err);
  //   })
  //   .on('end', function()
  //   {
  //     callback(null, results);
  //   });
}

Game.prototype._makeHandle = function Game__makeHandle(s)
{
  return unidecode.fold(s).toLowerCase().replace(/[^a-z0-9-]/g, '_').replace(/^[0-9-_]*/, '');
}

Game.prototype._convertToRedisString = function Game_convertToRedisString(value)
{
  if(value && value != undefined) {

    if( typeof value == "object") {
      return JSON.stringify(value);
    } else if ( typeof value == 'boolean' || typeof value == 'number' ) {
      return String(value);
    }

  } 

  return value;
}

Game.prototype._convertFromRedisString = function Game_convertFromRedisString(value)
{
  if(value && value != undefined) {

    if( this._typeOfRedisString(value) === 'object') {
      try{
        value = JSON.parse(value);
      } catch (err) {
        console.log("Error trying to parse JSON in convertFromRedisString");
        return value;
      }
    } else if( this._typeOfRedisString(value) === 'boolean') {
      if(value === 'true') {
        value = true;
      } else if(value === 'false') {
        value = false;
      } 
    } else if( this._typeOfRedisString(value) === 'number') {
      value = Number(value);
    }
  }

  return value;
}

Game.prototype._typeOfRedisString = function Game_typeOfRedisString(value)
{
  if(value) {
    if ( value.length>2 && (value.charAt(0) === '{') && (value.slice(-1) == "}") ) {
      return 'object';
    } else if (value === 'false' || value === 'true')
    {
      return 'boolean';
    } else if (!isNaN(value))
    {
      return 'number'
    }
  } else {
    return '';
  }
}



Game.prototype._resetAll = function Game_resetAll(callback)
{
  var _game   = this
    , channel = 'team'
    , ops     = []
    , key
    , pipeline = this._redis.pipeline();
    ;


  // _.each(this.team, function(teamKey)
  //         {  
  for (var teamKey in this.team)
  {
    console.log("JD: RESETALL teamKey:"+teamKey+" this.team[teamKey]="+this.team[teamKey]);
    if(this.team[teamKey] && this.team[teamKey].login){
      this.team[teamKey].points = 0; 
      this.team[teamKey].time_bonus = 0;
      this.team[teamKey].dollars = 0;
      this.team[teamKey].adjustment = 0;
      this.team[teamKey].answers = {};
      pipeline.set('team:'+teamKey, _game._convertToRedisString(this.team[teamKey]));
    }
  }

  for (var stateKey in this.state)
  {

    this.state[stateKey] = false;
    pipeline.set('state:'+stateKey, _game._convertToRedisString(false));
  }

  for (var questionKey in this.question)
  {
    this.question[questionKey] = _.merge(this.question[questionKey], {played: false, answer_shown: false});
    pipeline.set('question:'+questionKey, _game._convertToRedisString(this.question[questionKey]));
  }

  pipeline.exec(callback);

}




