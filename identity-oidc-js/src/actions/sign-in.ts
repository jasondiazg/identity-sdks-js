/**
 * Copyright (c) 2019, WSO2 Inc. (http://www.wso2.org) All Rights Reserved.
 *
 * WSO2 Inc. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import axios from "axios";
import { getCodeChallenge, getCodeVerifier, getEmailHash, getJWKForTheIdToken, isValidIdToken } from "./crypto";
import {
    getAuthorizeEndpoint,
    getIssuer,
    getJwksUri,
    getRevokeTokenEndpoint,
    getTokenEndpoint,
    initOPConfiguration,
    isValidOPConfig
} from "./op-config";
import { getSessionParameter, initUserSession, removeSessionParameter, setSessionParameter } from "./session";
import { handleSignOut } from "./sign-out";
import {
    ACCESS_TOKEN,
    AUTHORIZATION_CODE,
    ID_TOKEN,
    OIDC_SCOPE,
    PKCE_CODE_VERIFIER,
    REQUEST_PARAMS,
    SERVICE_RESOURCES
} from "../constants";
import { AuthenticatedUserInterface } from "../models/authenticated-user";
import { ConfigInterface } from "../models/client";
import { AccountSwitchRequestParams } from "../models/oidc-request-params";
import { TokenRequestHeader, TokenResponseInterface } from "../models/token-response";

/**
 * Checks whether authorization code is present.
 *
 * @returns {boolean} true if authorization code is present.
 */
export const hasAuthorizationCode = (): boolean => {
    return !!getAuthorizationCode();
};

/**
 * Resolves the authorization code.
 * If response mode is `form_post` authorization code is taken from the session storage.
 * And if the response mode is not defined or set to `query`, the code will be extracted from
 * the URL params.
 *
 * @returns {string} Resolved authorization code.
 */
export const getAuthorizationCode = (): string => {

    if (new URL(window.location.href).searchParams.get(AUTHORIZATION_CODE)) {
        return new URL(window.location.href).searchParams.get(AUTHORIZATION_CODE);
    }

    if (window.sessionStorage.getItem(AUTHORIZATION_CODE)) {
        return window.sessionStorage.getItem(AUTHORIZATION_CODE);
    }

    return null;
};

/**
 * Get token request headers.
 *
 * @param {string} clientHost
 * @returns {{headers: {Accept: string; "Access-Control-Allow-Origin": string; "Content-Type": string}}}
 */
const getTokenRequestHeaders = (clientHost: string): TokenRequestHeader => {
    return {
        headers: {
            "Accept": "application/json",
            "Access-Control-Allow-Origin": clientHost,
            "Content-Type": "application/x-www-form-urlencoded"
        }
    };
};

/**
 * Send authorization request.
 *
 * @param {ConfigInterface} requestParams request parameters required for authorization request.
 */
export const sendAuthorizationRequest = (requestParams: ConfigInterface): Promise<never>|boolean => {
    const authorizeEndpoint = getAuthorizeEndpoint();

    if (!authorizeEndpoint || authorizeEndpoint.trim().length === 0) {
        return Promise.reject(new Error("Invalid authorize endpoint found."));
    }

    let authorizeRequest = authorizeEndpoint + "?response_type=code&client_id="
        + requestParams.clientID;

    let scope = OIDC_SCOPE;

    if (requestParams.scope && requestParams.scope.length > 0) {
        if (!requestParams.scope.includes(OIDC_SCOPE)) {
            requestParams.scope.push(OIDC_SCOPE);
        }
        scope = requestParams.scope.join(" ");
    }

    authorizeRequest += "&scope=" + scope;
    authorizeRequest += "&redirect_uri=" + requestParams.loginCallbackURL;

    if (requestParams.responseMode) {
        authorizeRequest += "&response_mode=" + requestParams.responseMode;
    }

    if (requestParams.enablePKCE) {
        const codeVerifier = getCodeVerifier();
        const codeChallenge = getCodeChallenge(codeVerifier);
        setSessionParameter(PKCE_CODE_VERIFIER, codeVerifier);
        authorizeRequest += "&code_challenge_method=S256&code_challenge=" + codeChallenge;
    }

    if (requestParams.prompt) {
        authorizeRequest += "&prompt=" + requestParams.prompt;
    }

    document.location.href = authorizeRequest;

    return;
};

/**
 * Validate id_token.
 *
 * @param {string} clientID client ID.
 * @param {string} idToken id_token received from the IdP.
 * @returns {Promise<boolean>} whether token is valid.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const validateIdToken = (clientID: string, idToken: string,  serverOrigin: string): Promise<any> => {
    const jwksEndpoint = getJwksUri();

    if (!jwksEndpoint || jwksEndpoint.trim().length === 0) {
        return Promise.reject("Invalid JWKS URI found.");
    }

    return axios.get(jwksEndpoint)
        .then((response) => {
            if (response.status !== 200) {
                return Promise.reject(new Error("Failed to load public keys from JWKS URI: "
                    + jwksEndpoint));
            }

            const jwk = getJWKForTheIdToken(idToken.split(".")[0], response.data.keys);

            let issuer = getIssuer();

            if (!issuer || issuer.trim().length === 0) {
                issuer = serverOrigin + SERVICE_RESOURCES.token;
            }

            return Promise.resolve(isValidIdToken(idToken, jwk, clientID, issuer));
        }).catch((error) => {
            return Promise.reject(error);
        });
};

/**
 * Send token request.
 *
 * @param {ConfigInterface} requestParams request parameters required for token request.
 * @returns {Promise<TokenResponseInterface>} token response data or error.
 */
export const sendTokenRequest = (
    requestParams: ConfigInterface
): Promise<TokenResponseInterface> => {

    const tokenEndpoint = getTokenEndpoint();

    if (!tokenEndpoint || tokenEndpoint.trim().length === 0) {
        return Promise.reject(new Error("Invalid token endpoint found."));
    }

    const body = [];
    body.push(`client_id=${requestParams.clientID}`);

    if (requestParams.clientSecret && requestParams.clientSecret.trim().length > 0) {
        body.push(`client_secret=${requestParams.clientSecret}`);
    }

    const code = getAuthorizationCode();
    body.push(`code=${code}`);

    if (window.sessionStorage.getItem(AUTHORIZATION_CODE)) {
        window.sessionStorage.removeItem(AUTHORIZATION_CODE);
    }

    body.push("grant_type=authorization_code");
    body.push(`redirect_uri=${requestParams.loginCallbackURL}`);

    if (requestParams.enablePKCE) {
        body.push(`code_verifier=${getSessionParameter(PKCE_CODE_VERIFIER)}`);
        removeSessionParameter(PKCE_CODE_VERIFIER);
    }

    return axios.post(tokenEndpoint, body.join("&"), getTokenRequestHeaders(requestParams.clientHost))
        .then((response) => {
            if (response.status !== 200) {
                return Promise.reject(new Error("Invalid status code received in the token response: "
                    + response.status));
            }
            return validateIdToken(requestParams.clientID, response.data.id_token, requestParams.serverOrigin)
                .then((valid) => {
                if (valid) {
                    setSessionParameter(REQUEST_PARAMS, JSON.stringify(requestParams));

                    const tokenResponse: TokenResponseInterface = {
                        accessToken: response.data.access_token,
                        expiresIn: response.data.expires_in,
                        idToken: response.data.id_token,
                        refreshToken: response.data.refresh_token,
                        scope: response.data.scope,
                        tokenType: response.data.token_type
                    };

                    return Promise.resolve(tokenResponse);
                }

                return Promise.reject(new Error("Invalid id_token in the token response: " + response.data.id_token));
            });
        }).catch((error) => {
            return Promise.reject(error);
        });
};

/**
 * Send refresh token request.
 *
 * @param {ConfigInterface} requestParams request parameters required for token request.
 * @param {string} refreshToken
 * @returns {Promise<TokenResponseInterface>} refresh token response data or error.
 */
export const sendRefreshTokenRequest = (
    requestParams: ConfigInterface,
    refreshToken: string
): Promise<TokenResponseInterface> => {

    const tokenEndpoint = getTokenEndpoint();

    if (!tokenEndpoint || tokenEndpoint.trim().length === 0) {
        return Promise.reject("Invalid token endpoint found.");
    }

    const body = [];
    body.push(`client_id=${requestParams.clientID}`);
    body.push(`refresh_token=${refreshToken}`);
    body.push("grant_type=refresh_token");

    if (requestParams.clientSecret && requestParams.clientSecret.trim().length > 0) {
        body.push(`client_secret=${requestParams.clientSecret}`);
    }

    return axios.post(tokenEndpoint, body.join("&"), getTokenRequestHeaders(requestParams.clientHost))
        .then((response) => {
            if (response.status !== 200) {
                return Promise.reject(new Error("Invalid status code received in the refresh token response: "
                    + response.status));
            }
            return validateIdToken(requestParams.clientID, response.data.id_token, requestParams.serverOrigin)
                .then((valid) => {
                    if (valid) {
                        const tokenResponse: TokenResponseInterface = {
                            accessToken: response.data.access_token,
                            expiresIn: response.data.expires_in,
                            idToken: response.data.id_token,
                            refreshToken: response.data.refresh_token,
                            scope: response.data.scope,
                            tokenType: response.data.token_type
                        };

                        return Promise.resolve(tokenResponse);
                    }
                    return Promise.reject(new Error("Invalid id_token in the token response: " +
                        response.data.id_token));
                });
        }).catch((error) => {
            return Promise.reject(error);
        });
};

/**
 * Send revoke token request.
 *
 * @param {ConfigInterface} requestParams request parameters required for revoke token request.
 * @param {string} accessToken access token
 * @returns {any}
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sendRevokeTokenRequest = (requestParams: ConfigInterface, accessToken: string): Promise<any> => {
    const revokeTokenEndpoint = getRevokeTokenEndpoint();

    if (!revokeTokenEndpoint || revokeTokenEndpoint.trim().length === 0) {
        return Promise.reject("Invalid revoke token endpoint found.");
    }

    const body = [];
    body.push(`client_id=${requestParams.clientID}`);
    body.push(`token=${accessToken}`);
    body.push("token_type_hint=access_token");

    return axios.post(revokeTokenEndpoint, body.join("&"),
        { headers: getTokenRequestHeaders(requestParams.clientHost), withCredentials: true })
        .then((response) => {
            if (response.status !== 200) {
                return Promise.reject(new Error("Invalid status code received in the revoke token response: "
                    + response.status));
            }

            return Promise.resolve(response);
        }).catch((error) => {
            return Promise.reject(error);
        });
};

/**
 * Get user image from gravatar.com.
 *
 * @param emailAddress email address received authenticated user.
 * @returns {string} gravatar image path.
 */
export const getGravatar = (emailAddress: string): string => {
    return "https://www.gravatar.com/avatar/" + getEmailHash(emailAddress) + "?d=404";
};

/**
 * Get authenticated user from the id_token.
 *
 * @param idToken id_token received from the IdP.
 * @returns {AuthenticatedUserInterface} authenticated user.
 */
export const getAuthenticatedUser = (idToken: string): AuthenticatedUserInterface => {
    const payload = JSON.parse(atob(idToken.split(".")[1]));
    const emailAddress = payload.email ? payload.email : null;

    return {
        displayName: payload.preferred_username ? payload.preferred_username : payload.sub,
        email: emailAddress,
        username: payload.sub
    };
};

/**
 * Send account switch request.
 *
 * @param {AccountSwitchRequestParams} requestParams request parameters required for the account switch request.
 * @param {string} clientHost client host.
 * @returns {Promise<TokenResponseInterface>} token response data or error.
 */
export const sendAccountSwitchRequest = (
    requestParams: AccountSwitchRequestParams
): Promise<TokenResponseInterface> => {
    const tokenEndpoint = getTokenEndpoint();

    if (!tokenEndpoint || tokenEndpoint.trim().length === 0) {
        return Promise.reject(new Error("Invalid token endpoint found."));
    }

    let scope = OIDC_SCOPE;

    if (requestParams.scope && requestParams.scope.length > 0) {
        if (!requestParams.scope.includes(OIDC_SCOPE)) {
            requestParams.scope.push(OIDC_SCOPE);
        }
        scope = requestParams.scope.join(" ");
    }

    const body = [];
    body.push("grant_type=account_switch");
    body.push(`username=${ requestParams.username }`);
    body.push(`userstore-domain=${ requestParams["userstore-domain"] }`);
    body.push(`tenant-domain=${ requestParams["tenant-domain"] }`);
    body.push(`token=${ getSessionParameter(ACCESS_TOKEN) }`);
    body.push(`scope=${ scope }`);
    body.push(`client_id=${ requestParams.client_id }`);

    return axios.post(tokenEndpoint, body.join("&"), getTokenRequestHeaders(requestParams.clientHost))
        .then((response) => {
            if (response.status !== 200) {
                return Promise.reject(new Error("Invalid status code received in the token response: "
                    + response.status));
            }

            return validateIdToken(requestParams.client_id, response.data.id_token, requestParams.serverOrigin)
                .then((valid) => {
                    if (valid) {
                        const tokenResponse: TokenResponseInterface = {
                            accessToken: response.data.access_token,
                            expiresIn: response.data.expires_in,
                            idToken: response.data.id_token,
                            refreshToken: response.data.refresh_token,
                            scope: response.data.scope,
                            tokenType: response.data.token_type
                        };
                        return Promise.resolve(tokenResponse);
                    }

                    return Promise.reject(new Error("Invalid id_token in the token response: "
                        + response.data.id_token));
                });
        })
        .catch((error) => {
            return Promise.reject(error);
        });
};

/**
 * Execute user sign in request
 *
 * @param {object} requestParams
 * @param {function} callback
 * @returns {Promise<any>} sign out request status
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sendSignInRequest = (requestParams: ConfigInterface, callback?: () => void): Promise<any> => {
    if (hasAuthorizationCode()) {
        return sendTokenRequest(requestParams)
            .then((response) => {
                initUserSession(
                    response,
                    getAuthenticatedUser(response.idToken)
                );

                if (callback) {
                    callback();
                }

                return Promise.resolve(getAuthenticatedUser(response.idToken));
            })
            .catch((error) => {
                if (error.response && (error.response.status === 400)) {
                    sendAuthorizationRequest(requestParams);
                }

                return Promise.reject(error);
            });
    } else {
        sendAuthorizationRequest(requestParams);
    }
};

/**
 * Handle sign in requests
 *
 * @param {object} requestParams
 * @param {function} callback
 * @returns {Promise<any>} sign in status
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const handleSignIn = (requestParams: ConfigInterface, callback?: () => void): Promise<any> => {
    if (getSessionParameter(ACCESS_TOKEN) && getSessionParameter(ID_TOKEN)) {
        if (!isValidOPConfig(requestParams.tenant)) {
            return handleSignOut(requestParams);
        }

        if (callback) {
            callback();
        }

        return Promise.resolve(getAuthenticatedUser(getSessionParameter(ID_TOKEN)));
    } else {
        return initOPConfiguration(requestParams, false)
            .then(() => {
                return sendSignInRequest(requestParams, callback)
                    .then((response) => {
                        return Promise.resolve(response);
                    });
            }).catch((error) => {
                return Promise.reject(error);
            });
    }
};
