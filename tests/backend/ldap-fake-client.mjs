/**
 * In-process LDAP client double for authentication tests.
 *
 * `createLdapAuthenticator` accepts a `createClient` factory precisely so tests
 * can exercise the authenticator, allowlist ordering and error classification
 * without contacting a real directory. No real DN, account or password from the
 * company directory appears in tests.
 */
export function createFakeLdapClient(options = {}) {
  const users = new Map(Object.entries(options.users ?? {
    alice: { password: 'alice-secret', cn: 'Alice', mail: 'alice@example.test' }
  }))
  const behavior = options.behavior ?? {}
  const state = {
    binds: [],
    searches: 0,
    unbound: 0
  }

  function invalidCredentials() {
    const error = new Error('InvalidCredentialsError: 0x31 Invalid Credentials')
    error.code = 49
    return error
  }

  return {
    state,
    users,
    create() {
      return {
        async bind(dn, password) {
          state.binds.push({ dn, password })
          if (behavior.bindError) throw behavior.bindError
          const match = /^cn=([^,]+)/.exec(String(dn))
          const username = match ? match[1] : ''
          const user = users.get(username)
          if (!user || user.password !== password) throw invalidCredentials()
        },
        async search(base, request) {
          state.searches += 1
          if (behavior.searchError) throw behavior.searchError
          const filter = String(request?.filter ?? '')
          const username = /\(uid=([^)]*)\)/.exec(filter)?.[1]
          const entries = []
          for (const [name, user] of users) {
            if (username && username !== name) continue
            entries.push({ dn: `cn=${name},ou=People,dc=example,dc=test`, uid: name, cn: user.cn, mail: user.mail })
          }
          if (behavior.searchEmpty) return { searchEntries: [] }
          return { searchEntries: entries }
        },
        async unbind() {
          state.unbound += 1
        }
      }
    }
  }
}

