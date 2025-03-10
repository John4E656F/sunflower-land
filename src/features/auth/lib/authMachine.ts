import { sequence } from "0xsequence";
import { createMachine, Interpreter, assign } from "xstate";
import WalletConnectProvider from "@walletconnect/web3-provider";

import { loadBanDetails } from "features/game/actions/bans";
import { isFarmBlacklisted } from "features/game/actions/onchain";
import { CONFIG } from "lib/config";
import { ErrorCode, ERRORS } from "lib/errors";

import { wallet, WalletType } from "../../../lib/blockchain/wallet";
import { communityContracts } from "features/community/lib/communityContracts";
import { createAccount as createFarmAction } from "../actions/createAccount";
import {
  login,
  Token,
  decodeToken,
  removeSession,
  hasValidSession,
} from "../actions/login";
import { oauthorise, redirectOAuth } from "../actions/oauth";
import { CharityAddress } from "../components/CreateFarm";
import { randomID } from "lib/utils/random";
import { createFarmMachine } from "./createFarmMachine";
import { SEQUENCE_CONNECT_OPTIONS } from "./sequence";

const getFarmIdFromUrl = () => {
  const paths = window.location.href.split("/visit/");
  const id = paths[paths.length - 1];
  return parseInt(id);
};

const getDiscordCode = () => {
  const code = new URLSearchParams(window.location.search).get("code");

  return code;
};

const deleteFarmUrl = () =>
  window.history.pushState({}, "", window.location.pathname);

type Farm = {
  farmId: number;
  address: string;
  createdAt: number;
  blacklistStatus: "OK" | "VERIFY" | "PENDING" | "REJECTED" | "BANNED";
  verificationUrl?: string;
};

export interface Context {
  errorCode?: ErrorCode;
  transactionId?: string;
  farmId?: number;
  hash?: string;
  address?: string;
  token?: Token;
  rawToken?: string;
  captcha?: string;
  blacklistStatus?: "OK" | "VERIFY" | "PENDING" | "REJECTED";
  verificationUrl?: string;
  wallet?: WalletType;
  provider?: any;
}

export type Screen = "land" | "farm";

type StartEvent = Farm & {
  type: "START_GAME";
  screen: Screen;
};

type ExploreEvent = {
  type: "EXPLORE";
};

type VisitEvent = {
  type: "VISIT";
  farmId: number;
};

type ReturnEvent = {
  type: "RETURN";
};

type CreateFarmEvent = {
  type: "CREATE_FARM";
  charityAddress: CharityAddress;
  donation: number;
  captcha: string;
};

type LoadFarmEvent = {
  type: "LOAD_FARM";
};

export type BlockchainEvent =
  | StartEvent
  | ExploreEvent
  | VisitEvent
  | ReturnEvent
  | CreateFarmEvent
  | LoadFarmEvent
  | {
      type: "CHAIN_CHANGED";
    }
  | {
      type: "ACCOUNT_CHANGED";
    }
  | {
      type: "REFRESH";
    }
  | {
      type: "LOGOUT";
    }
  | {
      type: "CHOOSE_CHARITY";
    }
  | { type: "CONNECT_TO_DISCORD" }
  | { type: "CONFIRM" }
  | { type: "SKIP" }
  | { type: "CONNECT_TO_METAMASK" }
  | { type: "CONNECT_TO_WALLET_CONNECT" }
  | { type: "CONNECT_TO_SEQUENCE" }
  | { type: "SIGN" };

export type BlockchainState = {
  value:
    | "idle"
    | "initialising"
    | "visiting"
    | "connectingToMetamask"
    | "connectingToWalletConnect"
    | "connectingToSequence"
    | "setupContracts"
    | "connectedToWallet"
    | "reconnecting"
    | "connected"
    | "signing"
    | "oauthorising"
    | "blacklisted"
    | { connected: "loadingFarm" }
    | { connected: "farmLoaded" }
    | { connected: "noFarmLoaded" }
    | { connected: "creatingFarm" }
    | { connected: "countdown" }
    | { connected: "readyToStart" }
    | { connected: "donating" }
    | { connected: "authorised" }
    | { connected: "blacklisted" }
    | { connected: "visitingContributor" }
    | "exploring"
    | "checkFarm"
    | "unauthorised";
  context: Context;
};

const API_URL = CONFIG.API_URL;

export type MachineInterpreter = Interpreter<
  Context,
  any,
  BlockchainEvent,
  BlockchainState
>;

export const authMachine = createMachine<
  Context,
  BlockchainEvent,
  BlockchainState
>(
  {
    id: "authMachine",
    initial: API_URL ? "idle" : "connected",
    states: {
      idle: {
        id: "idle",
        on: {
          CONNECT_TO_METAMASK: {
            target: "connectingToMetamask",
          },
          CONNECT_TO_WALLET_CONNECT: {
            target: "connectingToWalletConnect",
          },
          CONNECT_TO_SEQUENCE: {
            target: "connectingToSequence",
          },
        },
      },
      reconnecting: {
        id: "reconnecting",
        always: [
          {
            target: "connectingToMetamask",
            cond: (context) => context.wallet === "METAMASK",
          },
          {
            target: "connectingToWalletConnect",
            cond: (context) => context.wallet === "WALLET_CONNECT",
          },
          {
            target: "connectingToSequence",
            cond: (context) => context.wallet === "SEQUENCE",
          },
          { target: "idle" },
        ],
      },
      connectingToMetamask: {
        id: "connectingToMetamask",
        invoke: {
          src: "initMetamask",
          onDone: {
            target: "setupContracts",
            actions: "assignWallet",
          },
          onError: {
            target: "unauthorised",
            actions: "assignErrorMessage",
          },
        },
      },
      connectingToWalletConnect: {
        id: "connectingToWalletConnect",
        invoke: {
          src: "initWalletConnect",
          onDone: {
            target: "setupContracts",
            actions: "assignWallet",
          },
          onError: [
            {
              target: "idle",
              cond: (_, event) => event.data.message === "User closed modal",
            },
            {
              target: "unauthorised",
              actions: "assignErrorMessage",
            },
          ],
        },
      },
      connectingToSequence: {
        id: "connectingToSequence",
        invoke: {
          src: "initSequence",
          onDone: {
            target: "setupContracts",
            actions: "assignWallet",
          },
          onError: [
            {
              target: "idle",
              cond: (_, event) =>
                event.data.message === ERRORS.SEQUENCE_NOT_CONNECTED,
            },
            {
              target: "unauthorised",
              actions: "assignErrorMessage",
            },
          ],
        },
      },
      setupContracts: {
        invoke: {
          src: async (context, event) => {
            const type: WalletType = (event as any).data?.wallet ?? "METAMASK";
            await wallet.initialise(context.provider, type);
            await communityContracts.initialise(context.provider);
          },
          onDone: [
            {
              target: "checkFarm",
              cond: "isVisitingUrl",
            },
            {
              target: "signing",
              cond: (context) => context.wallet === "METAMASK",
            },
            {
              target: "connectedToWallet",
            },
          ],
          onError: {
            target: "unauthorised",
            actions: "assignErrorMessage",
          },
        },
      },
      connectedToWallet: {
        always: { target: "signing", cond: () => hasValidSession() },
        on: { SIGN: { target: "signing" } },
      },
      signing: {
        entry: "setTransactionId",
        invoke: {
          src: "login",
          onDone: [
            {
              target: "oauthorising",
              cond: "hasDiscordCode",
            },
            {
              target: "connected",
              actions: "assignToken",
            },
          ],
          onError: {
            target: "unauthorised",
            actions: "assignErrorMessage",
          },
        },
      },
      oauthorising: {
        entry: "setTransactionId",
        invoke: {
          src: "oauthorise",
          onDone: {
            target: "connected.loadingFarm",
            actions: "assignToken",
          },
          onError: {
            target: "unauthorised",
            actions: "assignErrorMessage",
          },
        },
      },
      connected: {
        initial: API_URL ? "loadingFarm" : "authorised",
        states: {
          loadingFarm: {
            id: "loadingFarm",
            entry: "setTransactionId",
            invoke: {
              src: "loadFarm",
              onDone: [
                {
                  target: "countdown",
                  cond: "isFresh",
                },
                {
                  // event.data can be undefined if the player has no farms
                  cond: (_, event) => event.data?.blacklistStatus === "BANNED",
                  actions: "assignFarm",
                  target: "blacklisted",
                },

                {
                  target: "authorised",
                  actions: "assignFarm",
                  cond: "hasFarm",
                },

                { target: "noFarmLoaded" },
              ],
              onError: [
                {
                  target: "#loadingFarm",
                  cond: () => !wallet.isAlchemy,
                  actions: () => {
                    wallet.overrideProvider();
                  },
                },
                {
                  target: "#unauthorised",
                  actions: "assignErrorMessage",
                },
              ],
            },
          },
          visitingContributor: {
            on: {
              RETURN: [
                // When returning to this state the original authorised player's data exists in the authMachine context
                {
                  target: "authorised",
                  actions: (context) => {
                    window.location.href = `${window.location.pathname}#/land/${context.farmId}`;
                  },
                  cond: "hasFarm",
                },
                { target: "readyToStart" },
              ],
            },
          },

          donating: {
            invoke: {
              id: "createFarmMachine",
              src: createFarmMachine,
              data: {
                token: (context: Context) => context.rawToken,
              },
              onError: {
                target: "#unauthorised",
                actions: "assignErrorMessage",
              },
            },
            on: {
              CREATE_FARM: {
                target: "creatingFarm",
              },
              REFRESH: {
                target: "#reconnecting",
              },
            },
          },
          creatingFarm: {
            entry: "setTransactionId",
            invoke: {
              src: "createFarm",
              onDone: {
                target: "#reconnecting",
              },
              onError: {
                target: "#unauthorised",
                actions: "assignErrorMessage",
              },
            },
          },
          countdown: {
            on: {
              REFRESH: {
                target: "#reconnecting",
              },
            },
          },
          noFarmLoaded: {
            on: {
              CHOOSE_CHARITY: {
                target: "donating",
              },
              CONNECT_TO_DISCORD: {
                // Redirects to Discord OAuth so no need for a state change
                target: "noFarmLoaded",
                actions: redirectOAuth,
              },
              EXPLORE: {
                target: "#exploring",
              },
            },
          },
          farmLoaded: {
            always: {
              target: "readyToStart",
            },
          },
          readyToStart: {
            invoke: {
              src: async () => ({
                skipSplash: window.location.hash.includes("retreat"),
              }),
              onDone: {
                cond: (_, event) => event.data.skipSplash,
                target: "authorised",
              },
            },
            on: {
              START_GAME: [
                {
                  cond: (context) => context.blacklistStatus !== "OK",
                  target: "blacklisted",
                },
                {
                  target: "authorised",
                },
              ],
              EXPLORE: {
                target: "#exploring",
              },
            },
          },
          blacklisted: {
            on: {
              SKIP: {
                target: "authorised",
              },
            },
          },
          authorised: {
            id: "authorised",
            entry: [
              "clearTransactionId",
              (context, event) => {
                if (window.location.hash.includes("retreat")) return;

                const defaultScreen = "land";

                const { screen = defaultScreen } = event as StartEvent;

                if (CONFIG.API_URL) {
                  window.location.href = `${window.location.pathname}#/${screen}/${context.farmId}`;
                }
              },
            ],
            on: {
              RETURN: {
                target: "#reconnecting",
                actions: ["refreshFarm", "deleteFarmIdUrl"],
              },
              REFRESH: {
                target: "#reconnecting",
              },
              EXPLORE: {
                target: "#exploring",
              },
              VISIT: {
                target: "visitingContributor",
              },
              LOGOUT: {
                target: "#idle",
                actions: ["clearSession", "refreshFarm"],
              },
            },
          },
          supplyReached: {},
        },
      },
      unauthorised: {
        id: "unauthorised",
      },
      exploring: {
        id: "exploring",
        on: {
          LOAD_FARM: {
            target: "#loadingFarm",
          },
          VISIT: {
            target: "checkFarm",
          },
        },
      },
      // An anonymous user is visiting a farm
      checkFarm: {
        invoke: {
          src: "visitFarm",
          onDone: [
            {
              target: "blacklisted",
              cond: (_, event) => event.data.blacklistStatus !== "OK",
              actions: "assignFarm",
            },
            {
              target: "visiting",
              actions: "assignFarm",
              cond: "hasFarm",
            },
          ],
          onError: {
            target: "unauthorised",
            actions: "assignErrorMessage",
          },
        },
      },
      blacklisted: {},
      visiting: {
        entry: (context) => {
          window.location.href = `${window.location.pathname}#/visit/${context.farmId}`;
        },
        on: {
          RETURN: {
            target: "reconnecting",
            actions: ["refreshFarm", "deleteFarmIdUrl"],
          },
        },
      },
    },
    on: {
      CHAIN_CHANGED: {
        target: "reconnecting",
        actions: "refreshFarm",
      },
      ACCOUNT_CHANGED: {
        target: "reconnecting",
        actions: "refreshFarm",
      },
      REFRESH: {
        target: "reconnecting",
        actions: "refreshFarm",
      },
    },
  },
  {
    services: {
      initMetamask: async () => {
        const _window = window as any;

        // TODO add type support
        if (_window.ethereum) {
          const provider = _window.ethereum;

          if (provider.isPhantom) {
            throw new Error(ERRORS.PHANTOM_WALLET_NOT_SUPPORTED);
          }
          await provider.request({
            method: "eth_requestAccounts",
          });

          return { wallet: "METAMASK", provider };
        } else {
          throw new Error(ERRORS.NO_WEB3);
        }
      },
      initWalletConnect: async () => {
        // TODO abstract RPC constants
        const provider = new WalletConnectProvider({
          rpc: {
            80001: "https://matic-mumbai.chainstacklabs.com",
            137: "https://polygon-rpc.com/",
          },
        });
        //  Enable session (triggers QR Code modal)
        await provider.enable();

        return { wallet: "WALLET_CONNECT", provider };
      },
      initSequence: async () => {
        const network = CONFIG.NETWORK === "mainnet" ? "polygon" : "mumbai";

        const sequenceWallet = await sequence.initWallet(network);
        await sequenceWallet.connect(SEQUENCE_CONNECT_OPTIONS);

        if (!sequenceWallet.isConnected()) {
          throw Error(ERRORS.SEQUENCE_NOT_CONNECTED);
        }

        const provider = sequenceWallet.getProvider();

        return { wallet: "SEQUENCE", provider };
      },
      loadFarm: async (context): Promise<Farm | undefined> => {
        const farmAccounts = await wallet.getFarm()?.getFarms();

        if (farmAccounts?.length === 0) {
          return;
        }

        const createdAt = await wallet
          .getAccountMinter()
          ?.getCreatedAt(wallet.myAccount as string);

        // V1 just support 1 farm per account - in future let them choose between the NFTs they hold
        const farmAccount = farmAccounts[0];

        const { verificationUrl, botStatus, isBanned } = await loadBanDetails(
          farmAccount.tokenId,
          context.rawToken as string,
          context.transactionId as string
        );

        return {
          farmId: parseInt(farmAccount.tokenId),
          address: farmAccount.account,
          createdAt,
          blacklistStatus: botStatus ?? isBanned ? "BANNED" : "OK",
          verificationUrl,
        };
      },
      createFarm: async (context: Context, event: any): Promise<Context> => {
        const { charityAddress, donation, captcha } = event as CreateFarmEvent;

        const newFarm = await createFarmAction({
          charity: charityAddress,
          token: context.rawToken as string,
          captcha: captcha,
          transactionId: context.transactionId as string,
        });

        return {
          farmId: parseInt(newFarm.tokenId),
          address: newFarm.account,
        };
      },
      login: async (context): Promise<{ token: string }> => {
        const { token } = await login(context.transactionId as string);

        return {
          token,
        };
      },
      oauthorise: async (context) => {
        const code = getDiscordCode() as string;
        // Navigates to Discord OAuth Flow
        const { token } = await oauthorise(
          code,
          context.transactionId as string
        );

        return { token };
      },
      visitFarm: async (
        _context: Context,
        event: any
      ): Promise<Farm | undefined> => {
        const farmId = getFarmIdFromUrl() || (event as VisitEvent).farmId;
        const farmAccount = await wallet.getFarm()?.getFarm(farmId);

        const isBlacklisted = await isFarmBlacklisted(farmId);

        return {
          farmId: parseInt(farmAccount.tokenId),
          address: farmAccount.account,
          createdAt: 0,
          blacklistStatus: isBlacklisted ? "REJECTED" : "OK",
        };
      },
    },
    actions: {
      assignFarm: assign<Context, any>({
        farmId: (_context, event) => event.data.farmId,
        address: (_context, event) => event.data.address,
        blacklistStatus: (_context, event) => event.data.blacklistStatus,
        verificationUrl: (_context, event) => event.data.verificationUrl,
      }),
      assignToken: assign<Context, any>({
        token: (_context, event) => decodeToken(event.data.token),
        rawToken: (_context, event) => event.data.token,
      }),
      assignErrorMessage: assign<Context, any>({
        errorCode: (_context, event) => event.data.message,
      }),
      assignWallet: assign<Context, any>({
        wallet: (_context, event) => event.data.wallet,
        provider: (_context: any, event: any) => event.data.provider,
      }),
      refreshFarm: assign<Context, any>({
        farmId: () => undefined,
        address: () => undefined,
        token: () => undefined,
        rawToken: () => undefined,
      }),
      clearSession: () => removeSession(wallet.myAccount as string),
      deleteFarmIdUrl: deleteFarmUrl,
      setTransactionId: assign<Context, any>({
        transactionId: () => randomID(),
      }),
      clearTransactionId: assign<Context, any>({
        transactionId: () => undefined,
      }),
    },
    guards: {
      isFresh: (context: Context, event: any) => {
        if (!event.data?.farmId) {
          return false;
        }

        const secondsElapsed =
          Date.now() / 1000 - (event.data as Farm).createdAt;
        return secondsElapsed < 60;
      },
      hasFarm: (context: Context, event: any) => {
        // If coming from the loadingFarm transition the farmId with show up on the event
        // else we check for it on the context
        if (event.data?.farmId) {
          const { farmId } = event.data;

          return !!farmId;
        }

        return !!context.farmId;
      },
      isVisitingUrl: () => window.location.href.includes("visit"),
      hasDiscordCode: () => !!getDiscordCode(),
    },
  }
);
