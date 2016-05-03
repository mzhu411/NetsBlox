'use strict';

var R = require('ramda'),
    _ = require('lodash'),
    Utils = _.extend(require('../Utils'), require('../ServerUtils.js')),

    debug = require('debug'),
    log = debug('NetsBlox:API:Projects:log'),
    info = debug('NetsBlox:API:Projects:info'),
    trace = debug('NetsBlox:API:Projects:trace'),
    error = debug('NetsBlox:API:Projects:error');

var getProjectIndexFrom = function(name, user) {
    for (var i = user.projects.length; i--;) {
        if (user.projects[i].ProjectName === name) {
            return i;
        }
    }
    return -1;
};

/**
 * Find and set the given project's public value.
 *
 * @param {String} name
 * @param {User} user
 * @param {Boolean} value
 * @return {Boolean} success
 */
var setProjectPublic = function(name, user, value) {
    var index = getProjectIndexFrom(name, user);
    if (index === -1) {
        return false;
    }
    user.projects[index].Public = value;
    // TODO: Do something meaningful to either make it publicly accessible or private
    return true;
};

module.exports = [
    {
        Service: 'saveProject',
        Parameters: 'socketId',
        Method: 'Post',
        Note: '',
        middleware: ['hasSocket', 'isLoggedIn'],
        Handler: function(req, res) {
            var username = req.session.username,
                socketId = req.body.socketId;

            info('Initiating room save for ' + username);
            this.storage.users.get(username, (e, user) => {
                var room,
                    socket = this.sockets[socketId],
                    activeRoom;

                if (e) {
                    error(`Could not retrieve user "${username}"`);
                    return res.status(500).send('ERROR: ' + e);
                }

                if (!user) {
                    error(`user not found: "${username}" - cannot save!`);
                    return res.status(400).send('ERROR: user not found');
                }

                // Look up the user's room
                activeRoom = socket._room;
                if (!activeRoom) {
                    error(`Could not find active room for "${username}" - cannot save!`);
                    return res.status(500).send('ERROR: active room not found');
                }

                // Save the entire room
                if (socket.isOwner()) {
                    log(`saving entire room for ${socket.username}`);
                    // Create the room object
                    room = this.storage.rooms.new(user, activeRoom);
                    room.save(function(err) {
                        if (err) {
                            error(`room save failed for room "${activeRoom.name}" initiated by "${username}"`);
                            return res.status(500).send('ERROR: ' + err);
                        }
                        log(`room save successful for room "${activeRoom.name}" initiated by "${username}"`);
                        return res.send('room saved!');
                    });
                } else {  // just update the project cache for the given user
                    log(`caching ${socket.roleId} for ${socket.username}`);
                    activeRoom.cache(socket.roleId, err => {
                        if (err) {
                            error(`Could not cache the ${socket.roleId} for non-owner "${username}"`);
                            return res.status(500).send('ERROR: ' + err);
                        }
                        log(`cache of ${socket.roleId} successful for for non-owner "${username}"`);
                        return res.send('code saved!');
                    });
                }
            });
        }
    },
    {
        Service: 'getProjectList',
        Parameters: '',
        Method: 'Get',
        Note: '',
        middleware: ['isLoggedIn', 'noCache'],
        Handler: function(req, res) {
            var username = req.session.username;
            log(username +' requested project list');

            this.storage.users.get(username, (e, user) => {
                var previews,
                    rooms;

                if (e) {
                    this._logger.error(`Could not find user ${username}: ${e}`);
                    return res.status(500).send('ERROR: ' + e);
                }
                if (user) {
                    rooms = user.rooms || user.tables || [];

                    trace(`found project list (${rooms.length}) ` +
                        `for ${username}: ${rooms.map(room => room.name)}`);
                    // Return the following for each room:
                    //
                    //  + ProjectName
                    //  + Updated
                    //  + Notes
                    //  + Thumbnail
                    //  + Public?
                    //
                    // These values are retrieved from whatever role has notes
                    // or chosen arbitrarily (for now)

                    // Update this to parse the projects from the room list
                    previews = rooms.map(room => {
                        var preview,
                            roles,
                            role;

                        room.roles = room.roles || room.seats;
                        roles = Object.keys(room.roles);
                        preview = {
                            ProjectName: room.name,
                            Public: !!room.public
                        };

                        for (var i = roles.length; i--;) {
                            role = room.roles[roles[i]];
                            if (role) {
                                // Get the most recent time
                                preview.Updated = Math.max(
                                    preview.Updated || 0,
                                    new Date(role.Updated).getTime()
                                );

                                // Notes
                                preview.Notes = preview.Notes || role.Notes;
                                preview.Thumbnail = preview.Thumbnail ||
                                    role.Thumbnail;
                            }
                        }
                        preview.Updated = new Date(preview.Updated);  // to string
                        return preview;
                    });

                    info(`Projects for ${username} are ${JSON.stringify(
                        previews.map(preview => preview.ProjectName)
                        )}`
                    );
                        
                    if (req.query.format === 'json') {
                        return res.json(previews);
                    } else {
                        return res.send(Utils.serializeArray(previews));
                    }
                }
                return res.status(404);
            });
        }
    },
    {
        Service: 'getProject',
        Parameters: 'ProjectName',
        Method: 'post',
        Note: '',
        middleware: ['isLoggedIn', 'noCache'],
        Handler: function(req, res) {
            var username = req.session.username,
                roomName = req.body.ProjectName;

            log(username + ' requested project ' + req.body.ProjectName);
            this.storage.users.get(username, (e, user) => {
                if (e) {
                    error(`Could not find user ${username}: ${e}`);
                    return res.status(500).send('ERROR: ' + e);
                }
                trace(`looking up room "${roomName}"`);

                // For now, just return the project
                var room = user.rooms.find(room => room.name === roomName),
                    project,
                    activeRoom,
                    openRole,
                    role;

                if (!room) {
                    error(`could not find room ${roomName}`);
                    return res.status(404).send('ERROR: could not find room');
                }
                trace(`found room ${roomName} for ${username}`);

                activeRoom = this.rooms[Utils.uuid(room.owner, room.name)];

                // Check if it is actually the same - do the originTime's match?
                if (activeRoom && activeRoom.originTime === room.originTime) {
                    openRole = Object.keys(activeRoom.roles)
                        .filter(role => !activeRoom.roles[role])  // not occupied
                        .shift();

                    trace(`room "${roomName}" is already active`);
                    if (openRole && activeRoom.cachedProjects[openRole]) {  // Send an open role and add the user
                        trace(`adding ${username} to open role "${openRole}" at ` +
                            `"${roomName}"`);

                        role = activeRoom.cachedProjects[openRole];
                    } else {  // If no open role w/ cache -> make a new role
                        let i = 2,
                            base;

                        if (!openRole) {
                            openRole = base = 'new role';
                            while (activeRoom.hasOwnProperty(openRole)) {
                                openRole = `${base} (${i++})`;
                            }
                            trace(`creating new role "${openRole}" ` +
                                `at "${roomName}" for ${username}`);
                        } else {
                            // TODO: This is bad. User could be losing data!
                            error(`Found open role "${openRole}" but it is not cached!`);
                        }

                        info(`adding ${username} to new role "${openRole}" at ` +
                            `"${roomName}"`);

                        activeRoom.createRole(openRole);
                        role = {
                            ProjectName: openRole,
                            SourceCode: null,
                            SourceSize: 0
                        };
                        activeRoom.cachedProjects[openRole] = role;
                    }
                } else {

                    if (activeRoom) {
                        trace(`found active room but times don't match! (${roomName})`);
                        activeRoom.changeName();
                        activeRoom = null;
                    }

                    // If room is not active, pick a role arbitrarily
                    openRole = Object.keys(room.roles)[0];
                    role = room.roles[openRole];

                    if (!role) {
                        error('Found room with no roles!');
                        return res.status(500).send('ERROR: project has no roles');
                    }
                    trace(`room is not active. Selected role "${openRole}" ` +
                        `arbitrarily`);
                }

                // Send the project to the user
                project = Utils.serializeProject(role);
                return res.send(project);
            });
        }
    },
    {
        Service: 'deleteProject',
        Parameters: 'ProjectName,RoomName',
        Method: 'Post',
        Note: '',
        middleware: ['isLoggedIn'],
        Handler: function(req, res) {
            var username = req.session.username,
                project = req.body.ProjectName;

            log(username +' trying to delete "' + project + '"');
            this.storage.users.get(username, (e, user) => {
                var room;

                for (var i = user.rooms.length; i--;) {
                    room = user.rooms[i];
                    if (room.name === project) {
                        user.rooms.splice(i, 1);
                        trace(`project ${project} deleted`);
                        user.save();
                        return res.send('project deleted!');
                    }

                }
                error(`project ${project} not found`);
            });
        }
    },
    {
        Service: 'publishProject',
        Parameters: 'ProjectName',
        Method: 'Post',
        Note: '',
        middleware: ['isLoggedIn'],
        Handler: function(req, res) {
            var username = req.session.username,
                name = req.body.ProjectName;

            log(username +' is publishing project '+name);
            this.storage.users.get(username, function(e, user) {
                if (e) {
                    res.status(500).send('ERROR: ' + e);
                }
                var success = setProjectPublic(name, user, true);
                user.save();
                if (success) {
                    return res.send('"'+name+'" is now shared!');
                }
                return res.send('ERROR: could not find the project');
            });
        }
    },
    {
        Service: 'unpublishProject',
        Parameters: 'ProjectName',
        Method: 'Post',
        Note: '',
        middleware: ['isLoggedIn'],
        Handler: function(req, res) {
            var username = req.session.username,
                name = req.body.ProjectName;

            log(username +' is unpublishing project '+name);
            this.storage.users.get(username, function(e, user) {
                if (e) {
                    return res.status(500).send('ERROR: ' + e);
                }
                var success = setProjectPublic(name, user, false);
                user.save();
                if (success) {
                    return res.send('"'+name+'" is no longer shared');
                }
                return res.send('ERROR: could not find the project');
            });
        }
    }
].map(function(api) {
    // Set the URL to be the service name
    api.URL = api.Service;
    return api;
});
