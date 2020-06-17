import { execSync } from 'child_process'
import chokidar from 'chokidar'
import crypto from 'crypto'
import fs from 'fs'
import _ from 'lodash'
import rimraf from 'rimraf'
import { Profile, ProfileResult, Result, Task } from '../types'

const workDir = 'vm/workspace'

function fileService(outDir: string) {
  const taskFilePath = `${outDir}/tasks.json`
  const tasks = JSON.parse(fs.readFileSync(taskFilePath, 'utf8')) as Task

  const result: Result = {}
  tasks.profiles.forEach((profile) => {
    const resultProfilePath = `${outDir}/result_${profile.id}.json`
    if (fs.existsSync(resultProfilePath)) {
      result[profile.id] = JSON.parse(
        fs.readFileSync(resultProfilePath, 'utf8')
      ) as ProfileResult
    } else {
      result[profile.id] = { users: {} }
    }
  })
  console.log(result)

  return {
    tasks,
    result,
    setResult: (profileId?: string) => {
      const ids = profileId ? [profileId] : tasks.profiles.map((p) => p.id)
      ids.forEach((pid) => {
        const resultProfilePath = `${outDir}/result_${pid}.json`
        fs.writeFileSync(resultProfilePath, JSON.stringify(result[pid]))
      })
    },
  } as const
}

export function client(outDir: string, watchDir: string) {
  const { tasks, result, setResult } = fileService(outDir)
  const watchAllOption = { ignored: /^\./, persistent: true }
  const watcher = chokidar.watch(watchDir, watchAllOption)

  const profileCheck = {}
  tasks.profiles.forEach((p) => (profileCheck[p.dir] = p))
  const execEx = (path: string) =>
    exec(
      path,
      result,
      (profileId: string) => profileCheck[profileId],
      setResult
    )

  return {
    start: () => {
      if (!checkDockerRunning()) {
        throw new Error('java docker not running')
      }
      resetOtherFiles(result)
      setResult()
      console.log(`watch start "${tasks.codeRoot}"`)
      watcher
        .on('add', execEx)
        .on('change', execEx)
        .on('unlink', function (path) {
          console.log('File', path, 'has been removed')
        })
        .on('error', function (error) {
          console.error('Error happened', error)
        })
      return watcher
    },
  }
}

function exec(
  path: string,
  result: Result,
  getProfile: (name: string) => Profile | undefined,
  setResult: (profileId: string) => void
) {
  const paths = path.split('/')
  const filename = paths.pop()
  const studentId = paths.pop()
  const profileDir = paths.pop()
  if (!filename || !studentId || !profileDir) return
  const profile = getProfile(profileDir)

  if (!profile) return

  const file = profile.files.find((f) => new RegExp(f.regex).exec(filename))

  if (!file) {
    saveOtherFile(result, profile, studentId, filename)
    setResult(profile.id)
    return
  }
  const hash = filehash(path)

  const oldHash = _.get(result, [
    profile.id,
    'users',
    studentId,
    'results',
    file.name,
    'hash',
  ])

  const changed = hash !== oldHash
  if (!changed) return console.log('skip')
  // console.log(profileDir)
  // console.log(filename)
  // console.log({ hash, oldHash })
  if (file.case === 'check') {
    saveUserResult(result, profile, studentId, file.name, '', hash, 'OK')

    return
  }

  rimraf.sync(workDir)
  fs.mkdirSync(workDir)
  fs.copyFileSync(path, workDir + '/' + filename)

  if (file.case === 'load-test') {
    // copy
    const tfs = file.testFile.split('/')
    const testFileName = tfs.pop() || ''
    const testFilePath = `${workDir}/${testFileName}`
    fs.copyFileSync(file.testFile, testFilePath)
    const className = testFileName.split('.')[0] || ''
    const cmd = buildDockerCommand(`javac ${testFileName} && java ${className}`)
    const status = execSync(cmd, { encoding: 'utf8' }).trim() as 'OK' | 'NG'
    saveUserResult(result, profile, studentId, file.name, status, hash, status)
    setResult(profile.id)
  } else {
    const cmd = buildDockerCommand(`java ${filename} ${file.args || ''}`)
    const status = execSync(cmd, { encoding: 'utf8' })

    saveUserResult(
      result,
      profile,
      studentId,
      file.name,
      status,
      hash,
      status.match(file.expected) ? 'OK' : 'NG'
    )
    setResult(profile.id)
  }
}

function initializeUser(result: Result, profileId: string, studentId: string) {
  if (!result[profileId]) result[profileId] = { users: {} }
  if (!result[profileId].users[studentId])
    result[profileId].users[studentId] = { results: {}, otherFiles: [] }
}

function saveOtherFile(
  results: Result,
  profile: Profile,
  studentId: string,
  name: string
) {
  initializeUser(results, profile.id, studentId)

  results[profile.id].users[studentId].otherFiles.push({ name })
}

function saveUserResult(
  result: Result,
  profile: Profile,
  studentId: string,
  name: string,
  text: string,
  hash: string,
  status: 'OK' | 'NG'
) {
  console.log(`log: ${profile}, ${studentId}, ${name}, ${text}`)

  initializeUser(result, profile.id, studentId)

  if (!result[profile.id].users[studentId].results[name]) {
    result[profile.id].users[studentId].results[name] = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hash,
      text,
      status,
    }
  } else {
    result[profile.id].users[studentId].results[name] = {
      ...result[profile.id].users[studentId].results[name],
      updatedAt: Date.now(),
      hash,
      text,
      status,
    }
  }
}

function resetOtherFiles(result: Result) {
  Object.entries(result).map(([key, pr]) => {
    Object.entries(pr.users).map(([key, user]) => {
      user.otherFiles = []
    })
  })
}

function filehash(path) {
  const hash = crypto.createHash('md5')
  hash.update(fs.readFileSync(path))
  return hash.digest('base64')
}

function buildDockerCommand(command) {
  return `docker exec -i java /bin/bash -c "cd /root/workspace && ${command}"`
}

function checkDockerRunning() {
  try {
    return (
      execSync(`docker exec -i java /bin/bash -c "echo OK"`, {
        encoding: 'utf8',
      }).trim() === 'OK'
    )
  } catch (e) {
    // console.error(e)
    return false
  }
}
