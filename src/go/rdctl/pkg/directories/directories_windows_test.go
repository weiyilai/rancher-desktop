/*
Copyright © 2021 SUSE LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
package directories

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"golang.org/x/sys/windows"
)

func TestGetKnownFolder(t *testing.T) {
	t.Run("AppData", func(t *testing.T) {
		expected := os.Getenv("APPDATA")
		actual, err := getKnownFolder(windows.FOLDERID_RoamingAppData)
		if assert.NoError(t, err) {
			assert.Equal(t, expected, actual)
		}
	})
	t.Run("LocalAppData", func(t *testing.T) {
		expected := os.Getenv("LOCALAPPDATA")
		actual, err := getKnownFolder(windows.FOLDERID_LocalAppData)
		if assert.NoError(t, err) {
			assert.Equal(t, expected, actual)
		}
	})
	t.Run("invalid folder", func(t *testing.T) {
		zeroGUID := windows.KNOWNFOLDERID{}
		_, err := getKnownFolder(&zeroGUID)
		if assert.Error(t, err) {
			notFound := 0x80070002 // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
			assert.Equal(t, windows.Errno(notFound), err)
		}
	})
}
