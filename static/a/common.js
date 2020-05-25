$.domReady(function()
{
  var primus = new Primus();

  var game = new Game(
      { type        : window.gameType
      , d3          : d3
      , transport   : primus
      , gameplay    : '.gameplay'
      , scoreboard  : '.scoreboard'
      , teamsList   : '.scoreboard_teams'
      , timer       : '.timer'
      , question    : '.question'
      , questionText: '.question_text'
      , prequestion    : '.prequestion'
      , prequestionText: '.prequestion_text'
      , answer      : '.answer'
      , answerText  : '.answer_text'
      , vabank      : '.answer_form_messagebox_vabank'
      , vabankLabel : '.answer_form_label_for_vabank'
      , vabankIcon  : '.vabankIcon'
      })
    ;

  var chat = new Chat(
      { d3            : d3
      , transport     : primus
      , messageList   : '.log'
      , chatPanel     : '.chat'
      , messageBox    : '.chat_messagebox'
      , submitButton  : '.chat_messagebox_send'
      , userPanel     : '.user'
      , nicknameBox   : '.user_nickname'
      , userJoinButton: '.user_join'
      })
    ;

  // add cross reference
  chat.attach({game: game});

  game.attach({chat: chat});

  // do the hidden thing
  $('.hidden').hide().removeClass('hidden');
});

