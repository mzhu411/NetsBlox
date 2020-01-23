const express = require('express');
const Q = require('q');
const RemoteClient = require('./remote-client');
const Services = require('./services-worker');
const Logger = require('../logger');

class ServicesAPI {
    constructor() {
        this.router = this.createRouter();
        this.loading = Q.defer();

        this.logger = new Logger('netsblox:services');
        this.services = new Services(this.logger);
    }

    async initialize() {
        await this.services.initialize();
    }

    isServiceLoaded(name) {
        return this.services.isServiceLoaded(name);
    }

    getServices() {
        return Object.values(this.services.metadata);
    }

    getServiceNameFromDeprecated(name) {
        return Object.entries(this.services.compatibility)
            .find(pair => {
                const [validName, info] = pair;
                if (info.path && info.path.toLowerCase() === name) {
                    return validName;
                }
            }) || [null];
    }

    getValidServiceName(name) {
        if (this.services.metadata[name]) {
            return name;
        }

        name = name.toLowerCase();
        const validNames = Object.keys(this.services.metadata);
        let validName = validNames
            .find(serviceName => serviceName.toLowerCase() === name);

        if (validName) {
            return validName;
        }

        return this.getServiceNameFromDeprecated(name);
    }

    getServiceMetadata(name) {
        const validName = this.getValidServiceName(name);
        if (validName) {
            return this.services.metadata[validName];
        }
    }

    getDeprecatedArgName(serviceName, rpcName) {
        const compat = this.services.compatibility[serviceName];

        if (compat) {
            return compat.arguments[rpcName];
        }

        return null;
    }

    createRouter() {
        const router = express.Router({mergeParams: true});

        router.route('/').get((req, res) => {
            const metadata = Object.entries(this.services.metadata)
                .filter(nameAndMetadata => this.isServiceLoaded(nameAndMetadata[0]))
                .map(pair => {
                    const [name, metadata] = pair;
                    return {
                        name: name,
                        categories: metadata.categories
                    };
                });
            return res.send(metadata);
        });

        router.route('/:serviceName').get((req, res) => {
            const serviceName = this.getValidServiceName(req.params.serviceName);

            if (!this.isServiceLoaded(serviceName)) {
                return res.status(404).send(`Service "${serviceName}" is not available.`);
            }

            return res.json(this.services.metadata[serviceName]);
        });

        router.route('/:serviceName/:rpcName')
            .post((req, res) => {
                if (this.validateRPCRequest(req, res)) {
                    const {serviceName, rpcName} = req.params;
                    return this.invokeRPC(serviceName, rpcName, req, res);
                }
            });

        return router;
    }

    exists(serviceName, rpcName) {
        const service = this.services.metadata[serviceName];
        return service && !!service.rpcs[rpcName];
    }

    getArgumentNames(serviceName, rpcName) {
        const service = this.services.metadata[serviceName];
        return service.rpcs[rpcName].args.map(arg => arg.name);
    }

    validateRPCRequest(req, res) {
        const {serviceName, rpcName} = req.params;
        const {projectId, uuid} = req.query;

        if(!uuid || !projectId) {
            res.status(400).send('Project ID and client ID are required.');
        } else if (!this.isServiceLoaded(serviceName)) {
            res.status(404).send(`Service "${serviceName}" is not available.`);
        } else if (!this.exists(serviceName, rpcName)) {
            res.status(404).send(`RPC "${rpcName}" is not available.`);
        } else {
            return true;
        }

        return false;
    }

    invokeRPC(serviceName, rpcName, req, res) {
        const {projectId, roleId, uuid} = req.query;
        const expectedArgs = this.getArgumentNames(serviceName, rpcName);
        this.logger.info(`Received request to ${serviceName} for ${rpcName} (from ${uuid})`);

        const ctx = {};
        ctx.response = res;
        ctx.request = req;
        ctx.caller = {
            username: req.session.username,
            projectId,
            roleId,
            clientId: uuid
        };
        ctx.socket = new RemoteClient(projectId, roleId, uuid);

        // Get the arguments
        const oldFieldNameFor = this.getDeprecatedArgName(serviceName, rpcName) || {};
        const args = expectedArgs.map(argName => {
            const oldName = oldFieldNameFor[argName];
            return req.body.hasOwnProperty(argName) ? req.body[argName] : req.body[oldName];
        });

        return this.services.invoke(ctx, serviceName, rpcName, args);
    }
}

module.exports = new ServicesAPI();
