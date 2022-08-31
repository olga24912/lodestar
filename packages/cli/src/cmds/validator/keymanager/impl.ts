import bls from "@chainsafe/bls";
import {Keystore} from "@chainsafe/bls-keystore";
import {
  Api,
  DeleteRemoteKeyStatus,
  DeletionStatus,
  ImportStatus,
  ResponseStatus,
  KeystoreStr,
  PubkeyHex,
  SlashingProtectionData,
  SignerDefinition,
  ImportRemoteKeyStatus,
} from "@lodestar/api/keymanager";
import {fromHexString} from "@chainsafe/ssz";
import {Interchange, SignerType, Validator} from "@lodestar/validator";
import {getPubkeyHexFromKeystore, isValidatePubkeyHex, isValidHttpUrl} from "../../../util/format.js";
import {IPersistedKeysBackend} from "./interface.js";

export class KeymanagerApi implements Api {
  constructor(private readonly validator: Validator, private readonly persistedKeysBackend: IPersistedKeysBackend) {}

  /**
   * List all validating pubkeys known to and decrypted by this keymanager binary
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async listKeys(): ReturnType<Api["listKeys"]> {
    const pubkeys = this.validator.validatorStore.votingPubkeys();
    return {
      data: pubkeys.map((pubkey) => ({
        validatingPubkey: pubkey,
        derivationPath: "",
        readonly: this.validator.validatorStore.getSigner(pubkey)?.type !== SignerType.Local,
      })),
    };
  }

  /**
   * Import keystores generated by the Eth2.0 deposit CLI tooling. `passwords[i]` must unlock `keystores[i]`.
   *
   * Users SHOULD send slashing_protection data associated with the imported pubkeys. MUST follow the format defined in
   * EIP-3076: Slashing Protection Interchange Format.
   *
   * @param keystoresStr JSON-encoded keystore files generated with the Launchpad
   * @param passwords Passwords to unlock imported keystore files. `passwords[i]` must unlock `keystores[i]`
   * @param slashingProtectionStr Slashing protection data for some of the keys of `keystores`
   * @returns Status result of each `request.keystores` with same length and order of `request.keystores`
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async importKeystores(
    keystoresStr: KeystoreStr[],
    passwords: string[],
    slashingProtectionStr?: SlashingProtectionData
  ): ReturnType<Api["importKeystores"]> {
    if (slashingProtectionStr) {
      // The arguments to this function is passed in within the body of an HTTP request
      // hence fastify will parse it into an object before this function is called.
      // Even though the slashingProtectionStr is typed as SlashingProtectionData,
      // at runtime, when the handler for the request is selected, it would see slashingProtectionStr
      // as an object, hence trying to parse it using JSON.parse won't work. Instead, we cast straight to Interchange
      const interchange = ensureJSON<Interchange>(slashingProtectionStr);
      await this.validator.importInterchange(interchange);
    }

    const statuses: {status: ImportStatus; message?: string}[] = [];

    for (let i = 0; i < keystoresStr.length; i++) {
      try {
        const keystoreStr = keystoresStr[i];
        const password = passwords[i];
        if (password === undefined) {
          throw Error(`No password for keystores[${i}]`);
        }

        const keystore = Keystore.parse(keystoreStr);
        const pubkeyHex = getPubkeyHexFromKeystore(keystore);

        // Check for duplicates and skip keystore before decrypting
        if (this.validator.validatorStore.hasVotingPubkey(pubkeyHex)) {
          statuses[i] = {status: ImportStatus.duplicate};
          continue;
        }

        // Attempt to decrypt before writing to disk
        const secretKey = bls.SecretKey.fromBytes(await keystore.decrypt(password));

        // Persist the key to disk for restarts, before adding to in-memory store
        // If the keystore exist and has a lock it will throw
        this.persistedKeysBackend.writeKeystore({
          keystoreStr,
          password,
          // Lock immediately since it's gonna be used
          lockBeforeWrite: true,
          // Always write, even if it's already persisted for consistency.
          // The in-memory validatorStore is the ground truth to decide duplicates
          persistIfDuplicate: true,
        });

        // Add to in-memory store to start validating immediately
        this.validator.validatorStore.addSigner({type: SignerType.Local, secretKey});

        statuses[i] = {status: ImportStatus.imported};
      } catch (e) {
        statuses[i] = {status: ImportStatus.error, message: (e as Error).message};
      }
    }

    return {data: statuses};
  }

  /**
   * DELETE must delete all keys from `request.pubkeys` that are known to the keymanager and exist in its
   * persistent storage. Additionally, DELETE must fetch the slashing protection data for the requested keys from
   * persistent storage, which must be retained (and not deleted) after the response has been sent. Therefore in the
   * case of two identical delete requests being made, both will have access to slashing protection data.
   *
   * In a single atomic sequential operation the keymanager must:
   * 1. Guarantee that key(s) can not produce any more signature; only then
   * 2. Delete key(s) and serialize its associated slashing protection data
   *
   * DELETE should never return a 404 response, even if all pubkeys from request.pubkeys have no extant keystores
   * nor slashing protection data.
   *
   * Slashing protection data must only be returned for keys from `request.pubkeys` for which a
   * `deleted` or `not_active` status is returned.
   *
   * @param pubkeysHex List of public keys to delete.
   * @returns Deletion status of all keys in `request.pubkeys` in the same order.
   *
   * https://github.com/ethereum/keymanager-APIs/blob/0c975dae2ac6053c8245ebdb6a9f27c2f114f407/keymanager-oapi.yaml
   */
  async deleteKeys(pubkeysHex: PubkeyHex[]): ReturnType<Api["deleteKeys"]> {
    const deletedKey: boolean[] = [];
    const statuses = new Array<{status: DeletionStatus; message?: string}>(pubkeysHex.length);

    for (let i = 0; i < pubkeysHex.length; i++) {
      try {
        const pubkeyHex = pubkeysHex[i];

        if (!isValidatePubkeyHex(pubkeyHex)) {
          throw Error(`Invalid pubkey ${pubkeyHex}`);
        }

        // Skip unknown keys or remote signers
        const signer = this.validator.validatorStore.getSigner(pubkeyHex);
        if (signer && signer?.type === SignerType.Local) {
          // Remove key from live local signer
          deletedKey[i] = this.validator.validatorStore.removeSigner(pubkeyHex);

          // Remove key from blockduties
          // Remove from attestation duties
          // Remove from Sync committee duties
          // Remove from indices
          this.validator.removeDutiesForKey(pubkeyHex);
        }

        // Attempts to delete everything first, and returns status.
        // This unlocks the keystore, so perform after deleting from in-memory store
        const diskDeleteStatus = this.persistedKeysBackend.deleteKeystore(pubkeyHex);

        if (diskDeleteStatus) {
          // TODO: What if the diskDeleteStatus status is incosistent?
          deletedKey[i] = true;
        }
      } catch (e) {
        statuses[i] = {status: DeletionStatus.error, message: (e as Error).message};
      }
    }

    const pubkeysBytes = pubkeysHex.map((pubkeyHex) => fromHexString(pubkeyHex));

    const interchangeV5 = await this.validator.exportInterchange(pubkeysBytes, {
      version: "5",
    });

    // After exporting slashing protection data in bulk, render the status
    const pubkeysWithSlashingProtectionData = new Set(interchangeV5.data.map((data) => data.pubkey));
    for (let i = 0; i < pubkeysHex.length; i++) {
      if (statuses[i]?.status === DeletionStatus.error) {
        continue;
      }
      const status = deletedKey[i]
        ? DeletionStatus.deleted
        : pubkeysWithSlashingProtectionData.has(pubkeysHex[i])
        ? DeletionStatus.not_active
        : DeletionStatus.not_found;
      statuses[i] = {status};
    }

    return {
      data: statuses,
      slashingProtection: JSON.stringify(interchangeV5),
    };
  }

  /**
   * List all remote validating pubkeys known to this validator client binary
   */
  async listRemoteKeys(): ReturnType<Api["listRemoteKeys"]> {
    const remoteKeys: SignerDefinition[] = [];

    for (const pubkeyHex of this.validator.validatorStore.votingPubkeys()) {
      const signer = this.validator.validatorStore.getSigner(pubkeyHex);
      if (signer && signer.type === SignerType.Remote) {
        remoteKeys.push({pubkey: signer.pubkey, url: signer.url, readonly: false});
      }
    }

    return {
      data: remoteKeys,
    };
  }

  /**
   * Import remote keys for the validator client to request duties for
   */
  async importRemoteKeys(remoteSigners: SignerDefinition[]): ReturnType<Api["importRemoteKeys"]> {
    const results = remoteSigners.map(
      ({pubkey, url}): ResponseStatus<ImportRemoteKeyStatus> => {
        try {
          if (!isValidatePubkeyHex(pubkey)) {
            throw Error(`Invalid pubkey ${pubkey}`);
          }
          if (!isValidHttpUrl(url)) {
            throw Error(`Invalid URL ${url}`);
          }

          // Check if key exists
          if (this.validator.validatorStore.hasVotingPubkey(pubkey)) {
            return {status: ImportRemoteKeyStatus.duplicate};
          }

          // Else try to add it

          this.validator.validatorStore.addSigner({type: SignerType.Remote, pubkey, url});

          this.persistedKeysBackend.writeRemoteKey({
            pubkey,
            url,
            // Always write, even if it's already persisted for consistency.
            // The in-memory validatorStore is the ground truth to decide duplicates
            persistIfDuplicate: true,
          });

          return {status: ImportRemoteKeyStatus.imported};
        } catch (e) {
          return {status: ImportRemoteKeyStatus.error, message: (e as Error).message};
        }
      }
    );

    return {
      data: results,
    };
  }

  /**
   * DELETE must delete all keys from `request.pubkeys` that are known to the validator client and exist in its
   * persistent storage.
   * DELETE should never return a 404 response, even if all pubkeys from request.pubkeys have no existing keystores.
   */
  async deleteRemoteKeys(pubkeys: PubkeyHex[]): ReturnType<Api["deleteRemoteKeys"]> {
    const results = pubkeys.map(
      (pubkeyHex): ResponseStatus<DeleteRemoteKeyStatus> => {
        try {
          if (!isValidatePubkeyHex(pubkeyHex)) {
            throw Error(`Invalid pubkey ${pubkeyHex}`);
          }

          const signer = this.validator.validatorStore.getSigner(pubkeyHex);

          // Remove key from live local signer
          const deletedFromMemory =
            signer && signer?.type === SignerType.Remote
              ? this.validator.validatorStore.removeSigner(pubkeyHex)
              : false;

          // TODO: Remove duties

          const deletedFromDisk = this.persistedKeysBackend.deleteRemoteKey(pubkeyHex);

          return {
            status:
              deletedFromMemory || deletedFromDisk ? DeleteRemoteKeyStatus.deleted : DeleteRemoteKeyStatus.not_found,
          };
        } catch (e) {
          return {status: DeleteRemoteKeyStatus.error, message: (e as Error).message};
        }
      }
    );

    return {
      data: results,
    };
  }
}

/**
 * Given a variable with JSON that maybe stringified or not, return parsed JSON
 */
function ensureJSON<T>(strOrJson: string | T): T {
  if (typeof strOrJson === "string") {
    return JSON.parse(strOrJson) as T;
  } else {
    return strOrJson;
  }
}
