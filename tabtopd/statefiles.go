package main

import "path/filepath"

// stateFiles are the gateway's own files and folders: its login's (the
// users file, the VNC server's password), its links' and their key, the
// activity log, passkeys, and the remote browser's cookies, storage, site
// settings and filter lists, and its engines' shared cache. No root may
// hold one (newServer: through it they'd be read, and written, by whoever
// it's shared with); what saving one leaves behind is cleaned up
// (cleanGatewayTemps).
func (c serverConfig) stateFiles() []string {
	files := []string{c.usersFile, c.vncPasswordFile, c.sharesFile, c.shareKeyFile, c.activityFile, c.passkeysFile,
		c.goCookiesFile, c.goCookiesKeyFile, c.goStorageFile, c.goSitesFile, c.goAdBlockFile}
	if c.goAdBlockFile != "" {
		files = append(files, filepath.Join(filepath.Dir(c.goAdBlockFile), "go-filters"))
	}
	if c.goOn {
		if dir := goCachePath(); dir != "" {
			files = append(files, dir)
		}
	}
	return files
}
