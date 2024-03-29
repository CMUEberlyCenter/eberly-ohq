var db = require('../../db');
var dbEvents = require('../../db-events');
var EventEmitter = require('events');
var validator = require('jsonschema').validate;
var diff = require('deep-diff').diff;
var debug = require('debug')('app:queue');
var gsheets = require('./gsheets');

var logger = require('../logging/logger');

//
// Queue questions
//

var questions = (function() {
  var result = {
    getId: selectQuestionId,
    getOpen: selectQuestionsOpen,
    getOpenCount: selectOpenCount,
    getUserId: selectQuestionUserId,
    getOpenUserId: selectOpenQuestionUserId,
    getAnsweringUserId: selectAnsweringQuestionCaUserId,
    getLatestClosed: selectLatestClosed,
    getLatestClosedUserId: selectLatestClosedUserId,
    getWaitTime: selectWaitTime,
    getAverageWaitTime: selectAverageWaitTime,
    add: addQuestion,
    answer: answerQuestion,
    return: returnQuestion,
    freezeStudent: freezeStudentQuestion,
    unfreezeStudent: unfreezeStudentQuestion,
    freezeCa: freezeCaQuestion,
    freeze: freezeQuestionId,
    updateMeta: updateQuestionMeta,
    closeStudent: closeStudentQuestion,
    closeCa: closeCaQuestion,
    emitter: new EventEmitter()
  };

  // these are the pending unfreeze notifications to be sent
  var pendingUnfreezeNotifications = { };

  // helper function that gets a procedure which will emit the
  // unfreeze event, and clean up timers
  var notifyUnfrozen = function(id, course_id) {
    return function() {
      logger.info('question unfrozen');
      debug('question_unfrozen');
      selectQuestionId(id, course_id).then(function(question) {
        result.emitter.emit('question_unfrozen', question);
      });
      delete pendingUnfreezeNotifications[id];
    };
  };

  // populate the pending unfreeze notifications when the app starts.
  // need to make sure that all clients who have a question that'll be
  // unfrozen in the future are scheduled to be notified.
  db('courses').select('id').then(function (courses) {
    for (var i = 0; i < courses.length; i++) {
      selectQuestionsOpen(courses[i].id)
        .where('frozen_end_time', '>=', db.fn.now())
        .then(function(questions) {
          questions.forEach(function(question) {
            pendingUnfreezeNotifications[question.id] =
              setTimeout(
                notifyUnfrozen(question.id, question.course_id),
                Math.max(0, question.frozen_end_time - Date.now())
              );
          });
        });
    }
  });

  dbEvents.questions.on('update', function(newQuestion, oldQuestion) {
    logger.info('question update');
    // something happened to an existing question. find out what happened,
    // then emit an appropriate event
    var id = newQuestion.id;
    var course_id = newQuestion.course_id;
    var changes = diff(oldQuestion, newQuestion);
    for (var i in changes) {
      var change = changes[i];

      // there shouldn't be any adds/deletes
      if (['A', 'N', 'D'].indexOf(change.kind) !== -1) {
        throw new Error("Consistency error - row has added/deleted fields");
      }

      // the path shouldn't be nested
      if (change.path.length !== 1) {
        throw new Error("Consistency error - row is nested");
      }

      var emitEvent = function(eventName, course_id) {
        selectQuestionId(id, course_id).then(function(question) {
          result.emitter.emit(eventName, question);
        });
      };


      // check which field was updated, and emit an event
      var field = change.path[0];
      switch (field) {
        case 'frozen_time':
          debug('question_frozen');
          emitEvent('question_frozen', course_id);
          break;
        case 'frozen_end_time':
          // clear the pending event, and schedule a new one sometime
          // in the future, when the question is to be unfrozen
          clearTimeout(pendingUnfreezeNotifications[id]);
          pendingUnfreezeNotifications[id] = setTimeout(
            notifyUnfrozen(id, course_id),
            Math.max(0, Date.parse(change.rhs) - Date.now())
          );
          break;
        case 'help_time':
          if (was_changed("frozen_time",changes)) { break; }
          emitEvent('question_answered', course_id);
          break;
        case 'off_time':
          debug('question_closed');
          emitEvent('question_closed', course_id);
          if (pendingUnfreezeNotifications[id] !== undefined) {
            debug("delete freeze timer")
            clearTimeout(pendingUnfreezeNotifications[id]);
            delete pendingUnfreezeNotifications[id];
          }
          break;
        case 'ca_user_id':
          if ((was_changed("help_time",changes))) {
            if (newQuestion.ca_user_id == null) {
               //emit event releases ca_used_id as null
               selectQuestionId(oldQuestion.id, course_id).then(function(question) {
                result.emitter.emit("question_returned", oldQuestion.ca_user_id,question.id,question.course_id);
               });
              break;
            }
          }
        case "topic_id":
        case "location_id":
        case "help_text":
          emitEvent('question_update', course_id);
          break;
      }
    };

  });

  dbEvents.questions.on('insert', function(newQuestion) {
    logger.info('question insert');
    // emit the full inserted object
    selectQuestionId(newQuestion.id, newQuestion.course_id).then(function(question) {
      result.emitter.emit('new_question', question);
    });
  });

  dbEvents.questions.on('delete', function(oldQuestion) {
    logger.info('question delete');
    //happens on testing
    debug("Question deleted")
  });

  // When a user is edited, re-send their question
  dbEvents.users.on("update", function (new_user, old_user) {
    logger.info('user updated');
    if (new_user.first_name !== old_user.first_name) {
      db('roles').select('course')
                 .where('user', new_user.id)
                 .andWhere('role', 'student')
                 .then(function (role_lines) {
                   for (var i = 0; i < role_lines.length; i++) {
                     selectOpenQuestionUserId(new_user.id, role_lines[i].course).then(function(question) {
                       if (question) {
                         result.emitter.emit('question_update', question);
                       }
                     });
                   }
                 });
    }
  });


  return result;
})();

//
// Question selectors
//

function selectDefaultQuestionFields(course_id) {
  return db.select(
      'q.id                  AS id',
      'us.id                 AS student_user_id',
      'us.first_name         AS student_first_name',
      'us.last_name          AS student_last_name',
      'us.andrew_id          AS student_andrew_id',
      'uf.first_name         AS frozen_by_first_name',
      'uf.last_name          AS frozen_by_last_name',
      'uc.id                 AS ca_user_id',
      'uc.first_name         AS ca_first_name',
      'uc.last_name          AS ca_last_name',
      'ue.id                 AS initial_ca_user_id',
      'ue.first_name         AS initial_ca_first_name',
      'ue.last_name          AS initial_ca_last_name',
      't.id                  AS topic_id',
      't.topic               AS topic',
      'l.id                  AS location_id',
      'l.location            AS location',
      'q.help_text           AS help_text',
      'q.on_time             AS on_time',
      'q.frozen_time         AS frozen_time',
      'q.frozen_end_max_time AS frozen_end_max_time',
      'q.frozen_end_time     AS frozen_end_time',
      'q.help_time           AS help_time',
      'q.initial_help_time   AS initial_help_time',
      'q.off_time            AS off_time',
      'q.off_reason          AS off_reason',
      'q.course_id           AS course_id',
      function() {
        this.count('aq.id')
            .from('questions AS aq')
            .where('aq.off_time', null)
            .andWhere('aq.help_time', null)
            .andWhere('aq.course_id', course_id)
            .andWhere(db.raw('aq.on_time < q.on_time'))
            .as('queue_position');
      },
      function() {
        this.select(questionFrozen())
          .first()
          .as('is_frozen');
      },
      function() {
        this.select(questionCanFreeze())
          .first()
          .as('can_freeze');
      }
    )
    .from('questions AS q')
    .where('q.course_id', course_id)
    .leftJoin('users AS us', 'us.id', 'q.student_user_id')
    .leftJoin('users AS uf', 'uf.id', 'q.frozen_by')
    .leftJoin('users AS uc', 'uc.id', 'q.ca_user_id')
    .leftJoin('users AS ue', 'ue.id', 'q.initial_ca_user_id')
    .leftJoin('topics AS t', 't.id', 'q.topic_id')
    .leftJoin('locations AS l', 'l.id', 'q.location_id');
}

// get question by id
function selectQuestionId(id, course_id) {
  return selectDefaultQuestionFields(course_id)
    .where('q.id', id)
    .first();
}

// get question by user id
function selectQuestionUserId(id, course_id) {
  return selectDefaultQuestionFields(course_id)
    .where('q.student_user_id', id);
}

// get active question by user id
function selectOpenQuestionUserId(id, course_id) {
  return selectDefaultQuestionFields(course_id)
    .where('q.student_user_id', id)
    .andWhere(questionOpen())
    .first();
}

// get currently answering question by user id
function selectAnsweringQuestionCaUserId(caUserId, course_id) {
  return selectDefaultQuestionFields(course_id)
    .where('q.ca_user_id', caUserId)
    .andWhere(questionAnswering())
    .first();
}

// get open questions
function selectQuestionsOpen(course_id) {
  return selectDefaultQuestionFields(course_id)
    .where(questionOpen())
    .orderBy('q.on_time', 'desc');
}

// get the count of questions on the queue
function selectOpenCount(course_id) {
  return db.count('*')
    .from('questions AS q')
    .where(questionOpen())
    .andWhere(questionNotAnswering())
    .andWhere('course_id', course_id)
    .first()
    .then(function(questions) {
      return Promise.resolve(parseInt(questions.count));
    });
}

// get the last n closed questions
function selectLatestClosed(n, course_id) {
  return selectDefaultQuestionFields(course_id)
    .limit(n)
    .where(questionClosed())
    .orderBy('q.off_time', 'desc');
}

function selectLatestClosedUserId(n, studentId, course_id) {
  return selectLatestClosed(n, course_id).andWhere('q.student_user_id', studentId);
}

// condition for a question to be open
function questionOpen() {
  return db.raw('(q.off_time IS NULL)');
}


// condition for a question to be closed
function questionClosed() {
  return db.raw('(q.off_time IS NOT NULL)');
}

// condition for a question to be answering
function questionAnswering() {
  return db.raw('(q.help_time IS NOT NULL AND q.off_time IS NULL)');
}

// condition for a question to be not answering
// (apply demorgan's to questionAnswering)
function questionNotAnswering() {
  return db.raw('(q.help_time IS NULL OR q.off_time IS NOT NULL)');
}

// condition for a question to be frozen
function questionFrozen() {
  return db.raw(
        '(q.frozen_time IS NOT NULL AND ' +
        'q.frozen_end_time > NOW() AND ' +
        'q.frozen_end_max_time > NOW())'
    );
}

// condition for a question to be not frozen
// (apply demorgan's to questionFrozen)
function questionNotFrozen() {
  return db.raw(
        '(q.frozen_time IS NULL OR ' +
        ' q.frozen_end_time < NOW() OR ' +
        ' q.frozen_end_max_time < NOW())'
    );
}

// condition for whether a question can be frozen
function questionCanFreeze() {
  return db.raw(
        '(q.frozen_time IS NULL AND ' +
        ' q.off_time IS NULL)');
}

// Wait time
function selectWaitTime(startTime, endTime, course_id) {
  logger.info('select wait time');
  // round down to nearest 10 mins
  startTime = new Date(Math.floor(startTime.getTime() / (1000 * 60 * 10)) * (1000 * 60 * 10));

  // average question wait time
  var waitTime = 'AVG(' +
    'CASE WHEN frozen_time IS NOT NULL THEN ' +
    '  EXTRACT(EPOCH FROM (q.help_time - q.frozen_end_time + q.frozen_time - q.on_time)) ' +
    'ELSE ' +
    '  EXTRACT(EPOCH FROM (q.help_time - q.on_time)) ' +
    'END) AS wait_time';

  // round down the question's help time to a 10 minute interval
  var timePeriod = '' +
    'date_trunc(\'hour\', q.help_time) + ' +
    '((floor(extract(minute FROM q.help_time) / 10) * 10) || \' minutes\')::interval as time_period ';

  return db.select(
             db.raw(waitTime),
             db.raw(timePeriod))
           .from('questions AS q')
           .where('course_id', course_id)
           .andWhere('q.help_time', '>', startTime)
           .andWhere('q.help_time', '<', endTime)
           .andWhere(function() {
             db.where(questionClosed())
               .orWhere(questionAnswering())
           })
           .groupBy('time_period')
           .orderBy('time_period')
           .then(function(waitTimes) {
             var result = [];
             // fill in the gaps with 0s
             for (var time = startTime.getTime(); time < endTime.getTime(); time += 1000 * 60 * 10) {
               var found = false;
               for (var i = 0; !found && i < waitTimes.length; i++) {
                 if (Math.abs(waitTimes[i].time_period.getTime() - time) < 100) {
                   result.push(waitTimes[i]);
                   found = true;
                   break;
                 }
               }
               if (!found) {
                 result.push({
                   time_period: new Date(time),
                   wait_time: 0
                 });
               }
             }
             return Promise.resolve(result);
           });
}

// get the average wait time for all questions with start < help_time < end.
function selectAverageWaitTime(start, end, course_id) {
  logger.info('select average wait time');
  var waitTime = 'AVG(' +
    'CASE WHEN frozen_time IS NOT NULL THEN ' +
    '  EXTRACT(EPOCH FROM (q.help_time - q.frozen_end_time + q.frozen_time - q.on_time)) ' +
    'ELSE ' +
    '  EXTRACT(EPOCH FROM (q.help_time - q.on_time)) ' +
    'END) AS wait_time';
  return db.select(
              db.raw(waitTime))
           .from('questions AS q')
           .where('course_id', course_id)
           .andWhere('q.help_time', '>', start)
           .andWhere('q.help_time', '<', end)
           .andWhere(function() {
             db.where(questionClosed())
               .orWhere(questionAnswering());
           })
           .first()
           .then(function(waitTime) {
             waitTime = waitTime.wait_time;
             timePeriod = start;
             if (waitTime === null) {
               waitTime = 0;
             }
             return Promise.resolve({
               wait_time: waitTime,
               time_period: timePeriod,
             });
           });
}


//
// Question creators
//


// add a new question
function addQuestion(question) {
  logger.info('add question');
  // do some validation
  var questionInsertionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      student_user_id: {
        type: 'integer',
        required: true
      },
      topic_id: {
        type: 'integer',
        required: true
      },
      location_id: {
        type: 'integer',
        required: true
      },
      help_text: {
        type: 'string',
        required: true
      },
      course_id: {
        type: 'integer',
        required: true
      },
    }
  };

  var valid = validator(question, questionInsertionSchema);

  if (!valid.valid) {
    throw new Error('Invalid input');
  }

  // prepare the full object
  var insertQuestion = {
    student_user_id: question.student_user_id,
    topic_id: question.topic_id,
    location_id: question.location_id,
    help_text: question.help_text,
    course_id: question.course_id,
    on_time: db.fn.now()
  };

  db.transaction(function(trx) {
      selectCurrentMeta(question.course_id)
        .transacting(trx)
        .then(function(meta) {
          if (!meta.open) {
            throw { name: 'QueueClosedError', message: 'The queue is closed' };
          }
          return db.select('*')
                   .from('user_question_locks')
                   .where('user_id', question.student_user_id)
                   .transacting(trx)
                   .forUpdate();
        })
        .then(function() {
          return db.count('*')
                   .from('questions AS q')
                   .transacting(trx)
                   .where('q.student_user_id', insertQuestion.student_user_id)
                   .andWhere('q.course_id', insertQuestion.course_id)
                   .andWhere(questionOpen())
                   .first();
        })
        .then(function(activeQuestions) {
          if (parseInt(activeQuestions.count) !== 0) {
            throw { name: 'DoubleAddError', message: 'Student already has question' };
          }
          return db.insert(insertQuestion)
                   .into('questions')
                   .transacting(trx);
        })
        .then(trx.commit)
        .catch(trx.rollback);
      })
      .catch(function(err) {
        if (err.name === 'QueueClosedError') {

        } else if (err.name === 'DoubleAddError') {
          debug({ error: err, question: insertQuestion });
        } else {
          throw(err);
        }
      });

}

//
// Question updates
//

// answer a question
function answerQuestion(caUserId, course_id) {
  logger.info('answer question');
  db.transaction(function(trx) {
      db.select('*')
        .from('user_question_locks')
        .where('user_id', caUserId)
        .transacting(trx)
        .forUpdate()
        .then(function() {
          return db.count('*')
                   .from('questions AS q')
                   .where(questionNotFrozen())
                   .andWhere(questionOpen())
                   .andWhere({'ca_user_id': caUserId, 'course_id': course_id})
                   .transacting(trx)
                   .first();
        })
        .then(function(question) {
          return Promise.resolve(parseInt(question.count));
        })
        .then(function(count) {
          if (count > 0) {
            throw { name: 'DoubleAnswerError',
                    message: 'CA ' + caUserId + ' is already answering a question' };
          }

          else {
            return db.table('questions')
                     .update({
                       help_time: db.fn.now(),
                       ca_user_id: caUserId
                     })
                     .whereIn('id', function() {
                       this.select('id')
                           .from('questions AS q')
                           .where(questionNotFrozen())
                           .andWhere(questionOpen())
                           .andWhere(questionNotAnswering())
                           .andWhere('course_id', course_id)
                           .orderBy('on_time', 'asc')
                           .transacting(trx)
                           .first();
                     })
                     .transacting(trx);
          }
        })
        .then(trx.commit)
        .catch(trx.rollback);
    })
    .catch(function(err) {
      if (err.name === 'DoubleAnswerError') {
        debug({ error: err, ca: caUserId });
      } else {
        throw err;
      }
    });
}

//return question
function returnQuestion(caUserId, course_id) {
  logger.info('return question');
    db.table('questions AS q')
      .update({
        help_time: null,
        ca_user_id: null
      })
      .where({'ca_user_id': caUserId, 'course_id': course_id})
      .andWhere(questionAnswering())
      .then();
}

// update a question's details
function updateQuestionMeta(userId, question, course_id) {
  logger.info('update question meta');
  var questionUpdateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      location_id: {
        type: 'integer',
        required: false
      },
      topic_id: {
        type: 'integer',
        required: false
      },
      help_text: {
        type: 'string',
        required: false
      }
    }
  };

  var valid = validator(question, questionUpdateSchema);

  if (!valid.valid) {
    throw new Error('Invalid input');
  }

  db('questions')
    .update(question)
    .where('student_user_id', userId)
    .andWhere('off_time', null)
    .andWhere('course_id', course_id)
    .return(null);
}

// close a question

// close the student's active question
function closeStudentQuestion(studentId, course_id) {
  logger.info('close student question');
  return closeQuestion('self_kick', studentId, course_id)
    .where('q.student_user_id', studentId)
    .andWhere(questionOpen())
    .then();
}

// close the ca's active question
function closeCaQuestion(caUserId, reason, course_id) {
  logger.info('close ca question');
  return closeQuestion(reason, caUserId, course_id)
    .where('q.ca_user_id', caUserId)
    .andWhere(questionAnswering())
    .then();
}

// close an arbitary question
function closeQuestionId(userid, reason, questionId, course_id) {
  logger.info('close question id');
  return closeQuestion(reason, userid, course_id)
    .where('q.id', questionId)
    .andWhere('q.off_time', null)
    .then();
}

// update clause for question close
function closeQuestion(reason, offBy, course_id) {
  logger.info('closeQuestion');
  return db('questions AS q')
    .update({
      off_time: db.fn.now(),
      off_reason: reason,
      off_by: offBy
    }).where('q.course_id', course_id);
}

// freeze a student's question
function freezeStudentQuestion(studentId, course_id) {
  logger.info('freeze student question');
  return freezeQuestion(studentId, course_id)
    .where(questionOpen())
    .andWhere('q.student_user_id', studentId)
    .andWhere(questionNotAnswering())
    .then();
}

// unfreeze a student's question
function unfreezeStudentQuestion(studentId, course_id) {
  logger.info('unfreeze student question');
  return unfreezeQuestion(studentId, course_id)
    .where(questionOpen())
    .andWhere('q.student_user_id', studentId)
    .then();
}

// freeze a ca's current question
function freezeCaQuestion(caUserId, course_id) {
  logger.info('freeze ca question');
  return freezeQuestion(caUserId, course_id)
    .where(questionAnswering())
    .andWhere('q.ca_user_id', caUserId)
    .then();
}

// freeze a specific question
function freezeQuestionId(questionId, freezeByUserId, course_id) {
  logger.info('freeze question id');
  return freezeQuestion(freezeByUserId, course_id)
    .where('q.id', questionId)
    .then();
}

// update clause for question freeze
function freezeQuestion(frozenById, course_id) {
  logger.info('freezeQuestion');
  return db('questions AS q')
    .update({
      frozen_by: frozenById,
      frozen_time: db.fn.now(),
      frozen_end_max_time: db.raw(
        'NOW() + INTERVAL \'1 second\' * (SELECT max_freeze FROM queue_meta ORDER BY id DESC LIMIT 1)'),
      frozen_end_time: db.raw(
        'NOW() + INTERVAL \'1 second\' * (SELECT max_freeze FROM queue_meta ORDER BY id DESC LIMIT 1)'),
      initial_help_time: db.raw('help_time'),
      initial_ca_user_id: db.raw('ca_user_id'),
      help_time: null,
      ca_user_id: null
    })
    .where({'q.frozen_time': null, 'course_id': course_id});
}

// update clause for question unfreeze
function unfreezeQuestion(frozenById, course_id) {
  logger.info('unfreezeQuestion');
  return db('questions AS q')
    .update({ frozen_end_time: db.fn.now()})
    .where("course_id", course_id);
}

//
// Queue meta state
//

var meta = (function() {
  var result = {
    get: selectMeta,
    getCurrent: selectCurrentMeta,
    close: setQueueState(false),
    open: setQueueState(true),
    setTimeLimit: setTimeLimit,
    emitter: new EventEmitter()
  };
  dbEvents.queue_meta.on('insert', function(newMeta) {
    result.emitter.emit('update', cleanMeta(newMeta));
  });
  return result;
})();

function setTimeLimit(minutes, userid, course_id) {
  logger.info('setTimeLimit');
  if (Number.isInteger(parseInt(minutes)) && minutes > 0) {
    selectCurrentMeta(course_id).then(function(meta) {
      meta.time_limit = parseInt(minutes);
      meta.user_id = userid;
      meta.time = db.fn.now();
      meta.course_id = course_id;
      delete meta.id;
      return db('queue_meta')
        .insert(meta);
    });
  }
}

function cleanMeta(meta) {
  delete meta.registration_code;
  delete meta.user_id;
  delete meta.time;
  delete meta.id;
  return meta;
}

function setQueueState(state) {
  logger.info('setQueueState');
  return function(userid, course_id) {
    selectCurrentMeta(course_id).then(function(meta) {
      meta.open = state;
      meta.user_id = userid;
      meta.time = db.fn.now();
      delete meta.id;
      return db('queue_meta')
        .insert(meta);
    });
  };
}

function selectMeta(id, course_id) {
  return db.select('*')
    .from('queue_meta')
    .where('course_id', course_id)
    .where('id', id)
    .first();
}

function selectCurrentMeta(course_id) {
  return db.select('*')
    .from('queue_meta')
    .where('course_id', course_id)
    .orderBy('id', 'desc')
    .first();
}

//
// locations
//
var locations = (function() {
  var result = {
    getAll: selectAllLocations,
    getEnabled: selectEnabledLocations,
    addLocation: addLocation,
    deleteLocation: deleteLocation,
    enableLocation: enableLocation,
    emitter: new EventEmitter()
  };

  dbEvents.locations.on('insert', function(newLoc) {
        logger.info('insert location');
        db("locations").select("*").where({"id": newLoc.id}).then(function (loc){
          result.emitter.emit("new_location", loc)
        });
    });
  dbEvents.locations.on('update', function(new_locs, old_locs) {
    logger.info('update location');
    result.emitter.emit('update_location', [new_locs]);
  });

  return result;
})();

function enableLocation(loc, course_id) {
  logger.info('enable location');
  return db("locations").where({"id": loc, "course_id": course_id}).update({
    "enabled": true
  }).return(null);
}

function deleteLocation(loc, course_id) {
  logger.info('delete location');
  return db("locations").where({"id": loc, "course_id": course_id}).update({
    "enabled": false
  }).return(null);
}

function addLocation(loc, course_id) {
  logger.info('add location');
  db.insert({ "location": loc, "course_id": course_id })
                .into('locations')
                .return(null);
}

function selectAllLocations(course_id) {
  logger.info('select locations');
  return db.select(
      'id',
      'location',
      'enabled'
    )
    .from('locations')
    .where('course_id', course_id);
}

function selectEnabledLocations(course_id) {
  logger.info('select enabled locations');
  return selectAllLocations(course_id).where('enabled', true).orderByRaw('id DESC');
}

//
// topics
//
var topics = (function() {
  var result = {
    getAll: selectAllTopics,
    getEnabled: selectEnabledTopics,
    addTopic: addTopic,
    deleteTopic: deleteTopic,
    enableTopic: enableTopic,
    emitter: new EventEmitter(),
  };

  dbEvents.topics.on('insert', function(newTopic) {
        logger.info('insert topic');
        db("topics").select("*").where({"id": newTopic.id}).then(function (topic){
          result.emitter.emit("new_topic", topic)
        });
    });
  dbEvents.topics.on('update', function(new_topics, old_topics) {
    logger.info('update topic');
    result.emitter.emit('update_topic', [new_topics]);
  });

  return result;

})();

function enableTopic(topic, course_id) {
  logger.info('enableTopic');
  return db("topics").where({"id": topic, "course_id": course_id}).update({
    "enabled": true
  }).return(null);
}

function deleteTopic(topic, course_id) {
  logger.info('deleteTopic');
  return db("topics").where({"id": topic, "course_id": course_id}).update({
    "enabled": false
  }).return(null);
}

function addTopic(topic, course_id) {
  logger.info('addTopic');
   db.insert({ "topic": topic, "course_id": course_id })
                .into('topics')
                .return(null);
}

function selectAllTopics(course_id) {
  logger.info('selectAllTopics');
  return db.select(
      'id',
      'topic',
      'enabled'
    )
    .from('topics')
    .where('course_id', course_id);
}

function selectEnabledTopics(course_id) {
  logger.info('selectEnabledTopics');
  return selectAllTopics(course_id).where('enabled', true);
}


//
// utility functions
//


function was_changed(field_string, changes) {
  for (var i = 0; i < changes.length; i++) {
    if (field_string == changes[i].path) {
      return true
    }
  }
  return false
}

function was_kicked(changes) {
  for (var i = 0; i < changes.length; i++) {
    if (changes[i].path == "off_reason") {
      if (changes[i].rhs == "ca_kick") {
        return true
      }
    }
  }
  return false
}

module.exports.questions = questions;
module.exports.meta = meta;
module.exports.locations = locations;
module.exports.topics = topics;
