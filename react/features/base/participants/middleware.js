// @flow

import UIEvents from '../../../../service/UI/UIEvents';

import { NOTIFICATION_TIMEOUT, showNotification } from '../../notifications';
import { CALLING, INVITED } from '../../presence-status';

import { APP_WILL_MOUNT, APP_WILL_UNMOUNT } from '../app';
import {
    CONFERENCE_WILL_JOIN,
    forEachConference,
    getCurrentConference
} from '../conference';
import { JitsiConferenceEvents } from '../lib-jitsi-meet';
import { MiddlewareRegistry, StateListenerRegistry } from '../redux';
import { playSound, registerSound, unregisterSound } from '../sounds';

import {
    localParticipantIdChanged,
    localParticipantJoined,
    localParticipantLeft,
    participantLeft,
    participantUpdated,
    setLoadableAvatarUrl
} from './actions';
import {
    DOMINANT_SPEAKER_CHANGED,
    KICK_PARTICIPANT,
    MUTE_REMOTE_PARTICIPANT,
    PARTICIPANT_DISPLAY_NAME_CHANGED,
    PARTICIPANT_JOINED,
    PARTICIPANT_LEFT,
    PARTICIPANT_UPDATED
} from './actionTypes';
import {
    LOCAL_PARTICIPANT_DEFAULT_ID,
    PARTICIPANT_JOINED_SOUND_ID,
    PARTICIPANT_LEFT_SOUND_ID
} from './constants';
import {
    getFirstLoadableAvatarUrl,
    getLocalParticipant,
    getParticipantById,
    getParticipantCount,
    getParticipantDisplayName
} from './functions';
import { PARTICIPANT_JOINED_FILE, PARTICIPANT_LEFT_FILE } from './sounds';

declare var APP: Object;

/**
 * Middleware that captures CONFERENCE_JOINED and CONFERENCE_LEFT actions and
 * updates respectively ID of local participant.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case APP_WILL_MOUNT:
        _registerSounds(store);

        return _localParticipantJoined(store, next, action);

    case APP_WILL_UNMOUNT:
        _unregisterSounds(store);

        return _localParticipantLeft(store, next, action);

    case CONFERENCE_WILL_JOIN:
        store.dispatch(localParticipantIdChanged(action.conference.myUserId()));
        break;

    case DOMINANT_SPEAKER_CHANGED: {
        // Ensure the raised hand state is cleared for the dominant speaker.

        const { conference, id } = action.participant;
        const participant = getLocalParticipant(store.getState());

        participant
            && store.dispatch(participantUpdated({
                conference,
                id,
                local: participant.id === id,
                raisedHand: false
            }));

        break;
    }

    case KICK_PARTICIPANT: {
        const { conference } = store.getState()['features/base/conference'];

        conference.kickParticipant(action.id);
        break;
    }

    case MUTE_REMOTE_PARTICIPANT: {
        const { conference } = store.getState()['features/base/conference'];

        conference.muteParticipant(action.id);
        break;
    }

    // TODO Remove this middleware when the local display name update flow is
    // fully brought into redux.
    case PARTICIPANT_DISPLAY_NAME_CHANGED: {
        if (typeof APP !== 'undefined') {
            const participant = getLocalParticipant(store.getState());

            if (participant && participant.id === action.id) {
                APP.UI.emitEvent(UIEvents.NICKNAME_CHANGED, action.name);
            }
        }

        break;
    }

    case PARTICIPANT_JOINED: {
        _maybePlaySounds(store, action);

        return _participantJoinedOrUpdated(store, next, action);
    }

    case PARTICIPANT_LEFT:
        _maybePlaySounds(store, action);
        break;

    case PARTICIPANT_UPDATED:
        return _participantJoinedOrUpdated(store, next, action);
    }

    return next(action);
});

/**
 * Syncs the redux state features/base/participants up with the redux state
 * features/base/conference by ensuring that the former does not contain remote
 * participants no longer relevant to the latter. Introduced to address an issue
 * with multiplying thumbnails in the filmstrip.
 */
StateListenerRegistry.register(
    /* selector */ state => getCurrentConference(state),
    /* listener */ (conference, { dispatch, getState }) => {
        for (const p of getState()['features/base/participants']) {
            !p.local
                && (!conference || p.conference !== conference)
                && dispatch(participantLeft(p.id, p.conference));
        }
    });

/**
 * Reset the ID of the local participant to
 * {@link LOCAL_PARTICIPANT_DEFAULT_ID}. Such a reset is deemed possible only if
 * the local participant and, respectively, her ID is not involved in a
 * conference which is still of interest to the user and, consequently, the app.
 * For example, a conference which is in the process of leaving is no longer of
 * interest the user, is unrecoverable from the perspective of the user and,
 * consequently, the app.
 */
StateListenerRegistry.register(
    /* selector */ state => state['features/base/conference'],
    /* listener */ ({ leaving }, { dispatch, getState }) => {
        const state = getState();
        const localParticipant = getLocalParticipant(state);
        let id;

        if (!localParticipant
                || (id = localParticipant.id)
                    === LOCAL_PARTICIPANT_DEFAULT_ID) {
            // The ID of the local participant has been reset already.
            return;
        }

        // The ID of the local may be reset only if it is not in use.
        const dispatchLocalParticipantIdChanged
            = forEachConference(
                state,
                conference =>
                    conference === leaving || conference.myUserId() !== id);

        dispatchLocalParticipantIdChanged
            && dispatch(
                localParticipantIdChanged(LOCAL_PARTICIPANT_DEFAULT_ID));
    });

/**
 * Registers listeners for participant change events.
 */
StateListenerRegistry.register(
    state => state['features/base/conference'].conference,
    (conference, store) => {
        if (conference) {
            // We joined a conference
            conference.on(
                JitsiConferenceEvents.PARTICIPANT_PROPERTY_CHANGED,
                (participant, propertyName, oldValue, newValue) => {
                    switch (propertyName) {
                    case 'features_screen-sharing':
                        store.dispatch(participantUpdated({
                            conference,
                            id: participant.getId(),
                            features: { 'screen-sharing': true }
                        }));
                        break;
                    case 'raisedHand': {
                        _raiseHandUpdated(
                            store, conference, participant.getId(), newValue);
                        break;
                    }
                    default:

                        // Ignore for now.
                    }

                });
        } else {
            // We left the conference, raise hand of the local participant must be updated.
            _raiseHandUpdated(
                store, conference, undefined, false);
        }
    }
);

/**
 * Initializes the local participant and signals that it joined.
 *
 * @private
 * @param {Store} store - The redux store.
 * @param {Dispatch} next - The redux dispatch function to dispatch the
 * specified action to the specified store.
 * @param {Action} action - The redux action which is being dispatched
 * in the specified store.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _localParticipantJoined({ getState, dispatch }, next, action) {
    const result = next(action);

    const settings = getState()['features/base/settings'];

    dispatch(localParticipantJoined({
        avatarID: settings.avatarID,
        avatarURL: settings.avatarURL,
        email: settings.email,
        name: settings.displayName
    }));

    return result;
}

/**
 * Signals that the local participant has left.
 *
 * @param {Store} store - The redux store.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} into the specified {@code store}.
 * @param {Action} action - The redux action which is being dispatched in the
 * specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _localParticipantLeft({ dispatch }, next, action) {
    const result = next(action);

    dispatch(localParticipantLeft());

    return result;
}

/**
 * Plays sounds when participants join/leave conference.
 *
 * @param {Store} store - The redux store.
 * @param {Action} action - The redux action. Should be either
 * {@link PARTICIPANT_JOINED} or {@link PARTICIPANT_LEFT}.
 * @private
 * @returns {void}
 */
function _maybePlaySounds({ getState, dispatch }, action) {
    const state = getState();
    const { startAudioMuted } = state['features/base/config'];

    // We're not playing sounds for local participant
    // nor when the user is joining past the "startAudioMuted" limit.
    // The intention there was to not play user joined notification in big
    // conferences where 100th person is joining.
    if (!action.participant.local
            && (!startAudioMuted
                || getParticipantCount(state) < startAudioMuted)) {
        if (action.type === PARTICIPANT_JOINED) {
            const { presence } = action.participant;

            // The sounds for the poltergeist are handled by features/invite.
            if (presence !== INVITED && presence !== CALLING) {
                dispatch(playSound(PARTICIPANT_JOINED_SOUND_ID));
            }
        } else if (action.type === PARTICIPANT_LEFT) {
            dispatch(playSound(PARTICIPANT_LEFT_SOUND_ID));
        }
    }
}

/**
 * Notifies the feature base/participants that the action
 * {@code PARTICIPANT_JOINED} or {@code PARTICIPANT_UPDATED} is being dispatched
 * within a specific redux store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} in the specified {@code store}.
 * @param {Action} action - The redux action {@code PARTICIPANT_JOINED} or
 * {@code PARTICIPANT_UPDATED} which is being dispatched in the specified
 * {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _participantJoinedOrUpdated({ dispatch, getState }, next, action) {
    const { participant: { avatarURL, email, id, local, name, raisedHand } } = action;

    // Send an external update of the local participant's raised hand state
    // if a new raised hand state is defined in the action.
    if (typeof raisedHand !== 'undefined') {
        if (local) {
            const { conference } = getState()['features/base/conference'];

            conference
                && conference.setLocalParticipantProperty(
                    'raisedHand',
                    raisedHand);
        }
    }

    // Allow the redux update to go through and compare the old avatar
    // to the new avatar and emit out change events if necessary.
    const result = next(action);

    if (avatarURL || email || id || name) {
        const participantId = !id && local ? getLocalParticipant(getState()).id : id;
        const updatedParticipant = getParticipantById(getState(), participantId);

        getFirstLoadableAvatarUrl(updatedParticipant)
            .then(url => {
                dispatch(setLoadableAvatarUrl(participantId, url));
            });
    }

    // Notify external listeners of potential avatarURL changes.
    if (typeof APP === 'object') {
        const currentKnownId = local ? APP.conference.getMyUserId() : id;

        // Force update of local video getting a new id.
        APP.UI.refreshAvatarDisplay(currentKnownId);
    }

    return result;
}

/**
 * Handles a raise hand status update.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @param {Object} conference - The conference for which we got an update.
 * @param {string?} participantId - The ID of the participant from which we got an update. If undefined,
 * we update the local participant.
 * @param {boolean} newValue - The new value of the raise hand status.
 * @returns {void}
 */
function _raiseHandUpdated({ dispatch, getState }, conference, participantId, newValue) {
    const raisedHand = newValue === 'true';
    const pid = participantId || getLocalParticipant(getState()).id;

    dispatch(participantUpdated({
        conference,
        id: pid,
        raisedHand
    }));

    if (raisedHand) {
        dispatch(showNotification({
            titleArguments: {
                name: getParticipantDisplayName(getState, pid)
            },
            titleKey: 'notify.raisedHand'
        }, NOTIFICATION_TIMEOUT));
    }
}

/**
 * Registers sounds related with the participants feature.
 *
 * @param {Store} store - The redux store.
 * @private
 * @returns {void}
 */
function _registerSounds({ dispatch }) {
    dispatch(
        registerSound(PARTICIPANT_JOINED_SOUND_ID, PARTICIPANT_JOINED_FILE));
    dispatch(registerSound(PARTICIPANT_LEFT_SOUND_ID, PARTICIPANT_LEFT_FILE));
}

/**
 * Unregisters sounds related with the participants feature.
 *
 * @param {Store} store - The redux store.
 * @private
 * @returns {void}
 */
function _unregisterSounds({ dispatch }) {
    dispatch(unregisterSound(PARTICIPANT_JOINED_SOUND_ID));
    dispatch(unregisterSound(PARTICIPANT_LEFT_SOUND_ID));
}
