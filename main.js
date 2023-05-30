#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////
//    Copyright (C) 2019 Wizardry and Steamworks - License: CC BY 2.0    //
///////////////////////////////////////////////////////////////////////////

const mqtt = require('mqtt')
const YAML = require('yamljs')
const { createLogger, format, transports } = require('winston')
const Discord = require('discord.js')
const discordClient = new Discord.Client()
const qs = require('qs')
const path = require('path')
const fs = require('fs')
const uuid = require('uuid')

// Stores messages sent by Corrade.
const corradeMessages = {}

// Stores the Discord channel identifier.
var discordChannelID = -1

// Regex that determines whether a SecondLife group message is a message
// that has been relayed by Corrade to the SecondLife group.
const groupDiscordRegex = new RegExp(/^.+?#[0-9]+? \[Discord\]:.+?$/gm)

// Load configuration file.
const config = YAML.load('config.yml')

// Set up logger.
const logger = createLogger({
    format: format.combine(
        format.splat(),
        format.simple()
    ),
    transports: [
        new transports.Console({
            timestamp: true
        }),
        new transports.File(
            {
                timestamp: true,
                filename: path.join(path.dirname(fs.realpathSync(__filename)), "log/corrade-group-discord-bridge.log")
            }
        )
    ]
})

// Subscribe to Corrade MQTT.
const mqttClient = mqtt.connect(config.corrade.mqtt)

mqttClient.on('reconnect', () => {
    logger.info('Reconnecting to Corrade MQTT server...')
})

mqttClient.on('connect', () => {
    logger.info('Connected to Corrade MQTT server.')
    // Subscribe to group message notifications with group name and password.
    mqttClient.subscribe(`${config.corrade.group.name}/${config.corrade.group.password}/group`, (error) => {
        if (error) {
            logger.info('Error subscribing to Corrade MQTT group messages.')
            return
        }

        logger.info('Subscribed to Corrade MQTT group messages.')
    })
})

mqttClient.on('close', () => {
    logger.error('Disconnected from Corrade MQTT server...')
})

mqttClient.on('error', (error) => {
    logger.error(`Error found while connecting to Corrade MQTT server ${error}`)
})

mqttClient.on('message', (topic, message) => {
    // If the Discord channel is not yet known then do not process the notification.
    if (discordChannelID === -1) {
        logger.error('Message received from Corrade but Discord channel could not be retrieved, please check your configuration')
        return
    }

    // Make an object out of the notification.
    let mqttMessage = qs.parse(message.toString())

    // Check that the "tell" command was successful and warn otherwise.
    if (typeof mqttMessage.command !== 'undefined' && mqttMessage.command !== 'tell') {
        // Do not process commands without a success status.
        if (typeof mqttMessage.success === 'undefined') {
            return
        }
        // Check for the message id sent as afterburn.
        if (typeof mqttMessage.id === 'undefined' || typeof corradeMessages[mqttMessage.id] === 'undefined') {
            logger.warn(`Found message that does not belong to us: ${JSON.stringify(mqttMessage)}`)
            return
        }
        switch (mqttMessage.success) {
            case 'True':
                logger.info(`Successfully sent message with ID: ${mqttMessage.id}`)
                break
            case 'False':
                logger.warn(`Tell command failed: ${JSON.stringify(mqttMessage)}`)
                break
        }
        // Delete the message.
        delete corradeMessages[mqttMessage.id]
        return
    }

    // Check the notification parameters for sanity.
    if (typeof mqttMessage.type === 'undefined' || mqttMessage.type !== 'group') {
        logger.info('Skipping message without notification type...')
        return
    }

    let notification = mqttMessage

    if (notification.group.toUpperCase() !== config.corrade.group.name.toUpperCase()) {
        logger.info('Ignoring message for group not defined within the configuration...')
        return
    }

    // Ignore system messages; for example, when no group member is online in the group.
    if (notification.firstname === 'Second' && notification.lastname === 'Life') {
        logger.info('Ignoring system message...')
        return
    }

    // If this is a message relayed by Corrade to Discord, then ignore 
    // the message to prevent echoing the message multiple times.
    if (notification.message.match(groupDiscordRegex)) {
        logger.info('Ignoring relayed message...')
        return
    }

    // Send the message to the channel.
    discordClient
        .channels
        .cache
        .get(discordChannelID)
        .send(`${notification.firstname} ${notification.lastname} [SL]: ${notification.message}`)
})

discordClient.on('message', (message) => {
    // For Discord, ignore messages from bots (including self).
    if (message.author.bot) {
        logger.info(`Not relaying Discord message from Discord bot ${JSON.stringify(message.author.username)}...`)
        return
    }

    let messageContent = message.content
    if (message.attachments.length !== 0) {
        message.attachments.forEach(attachment => messageContent = `${messageContent} ${attachment.url}`)
    }

    // Ignore empty messages.
    if (messageContent.length == 0) {
        logger.info('Not relaying empty Discord message...')
        return
    }

    // Ignore messages that are not from the configured channel.
    if (message.channel.id !== discordChannelID) {
        logger.info(`Not relaying Discord message from Discord channel #${JSON.stringify(message.channel.name)} other than the configured channel...`)
        return
    }

    // Check if this is the intended server.
    if (message.channel.guild.name !== config.discord.server) {
        logger.info(`Not relaying Discord message from different server ${JSON.stringify(message.channel.guild.name)} other than the configured server...`)
        return
    }

    // Discard anything but text messages.
    if (message.channel.type !== 'text') {
        logger.info(`Not relaying Discord message of type ${JSON.stringify(message.channel.type)} that is not text...`)
        return
    }

    // If the message contains the special prefix then pass the message
    // as it is without prefixing it with the Discord username.
    let reply = `${message.author.username}#${message.author.discriminator} [Discord]: ${messageContent}`

    // Generate an unique identifier to be passed via afterburn to check whether messages have been sent.
    let id = uuid.v4()

    // Build the command.
    let payload = {
        'command': 'tell',
        'group': config.corrade.group.name,
        'password': config.corrade.group.password,
        'entity': 'group',
        'target': config.corrade.group.uuid,
        'message': reply,
        'id': id
    }

    // Build the tell command.
    const corradeCommand = qs.stringify(payload)

    // Store the message and check success status later.
    corradeMessages[id] = payload

    // Send the command to the Corrade MQTT broker.
    mqttClient.publish(`${config.corrade.group.name}/${config.corrade.group.password}/group`, corradeCommand)
})

// Retrieve channel ID when Discord is ready.
discordClient.on('ready', () => {
    logger.info('Connected to Discord.')

    const channel = discordClient
        .channels
        .cache
        .find(channel => channel.name === config.discord.channel &&
            channel.guild.name === config.discord.server)

    logger.info('Querying channels...')
    discordClient.channels.cache.forEach(channel => {
        logger.info(`Found channel ${channel.name}`)
    })

    if (typeof channel === 'undefined' || channel == null) {
        logger.error('The channel could not be found on discord.')
        return
    }

    logger.info('Discord channel ID retrieved successfully.')
    discordChannelID = channel.id
})

discordClient.on('error', (error) => {
    logger.error(`Error occurred whilst connecting to Discord: ${error}`)
})

discordClient.on('reconnecting', () => {
    logger.error('Reconnecting to Discord...')
})

// Login to discord.
discordClient.login(config.discord.botKey)
    .then(() => {
        logger.info('Logged-in to Discord.')
    })
    .catch((error) => {
        logger.error('Failed to login to Discord.')
    });
