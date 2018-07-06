var fs = require('fs');
var os = require('os');
var url = require('url');
var axios = require('axios');
var Promise = require('promise');
var shell = require('shelljs');
var save = require('save-file');
var argsParser = require("args-parser");

const AUTHOR = 1;
const REPOSITORY = 2;
const BRANCH = 4;


// The default output directory is the current directory
var outputDirectory = './';
// Default authentication setting
var authentication = {};

const args = argsParser(process.argv);
(function tackleArgs() {
    // The url is required and should be a valid github repository url
    if (!args.url) {
        throw new Error("input a url")
    } else {
        checkGithubRepoUrlvalidity(args.url);
    }

    if (args.out) {
        outputDirectory = args.out;
        if (outputDirectory[args.out.length-1] !== '/') {
            outputDirectory = outputDirectory + "/";
        }

        // Expand tilde
        if (outputDirectory[0] === '~') {
            outputDirectory = os.homedir() + outputDirectory.substring(1);
        }
    }

    if (args.auth) {
        let auth = args.auth;

        let colonPos = auth.indexOf(':');
        if ( colonPos==-1 || colonPos == auth.length-1) {
            throw new Error("Bad auth option: username:password is expected!");
        }

        [username, password] = auth.split(':');
        authentication.auth = {
            username,
            password
        }
    }
})();

function checkGithubRepoUrlvalidity(downloadUrl) {
       var {hostname, pathname} = url.parse(downloadUrl, true);

       if (hostname !== "github.com") {
           throw new Error("Invalid domain: github.com is expected!")
       }

       if (pathname.split('/').length < 3) {
           throw new Error("Invalid url: https://github.com/user/repository is expected")
       }
}

var parameters = {
    url: args.url,
    fileName: undefined,
    rootDirectory: undefined
};


// Read configuration file
const defaultConfigFile = `${os.homedir()}/.download_github`;

// If no command line authentication provided, read the configuration file
if (!authentication.auth) {
    (function parseConfig(){
        var exists = fs.existsSync(defaultConfigFile);
        if (exists) {
            var data = fs.readFileSync(defaultConfigFile, 'utf8');
            authentication = JSON.parse(data);
        }
    })();
}


function parseInfo(parameters) {

    var repoPath = url.parse(parameters.url, true).pathname;
    var splitPath = repoPath.split("/");
    var info = {};

    info.author = splitPath[AUTHOR];
    info.repository = splitPath[REPOSITORY];
    info.branch = splitPath[BRANCH];
    info.rootName = splitPath[splitPath.length-1];

    info.urlPrefix = `https://api.github.com/repos/${info.author}/${info.repository}/contents/`;
    info.urlPostfix = `?ref=${info.branch}`;

    if(!!splitPath[BRANCH]){
        info.resPath = repoPath.substring(repoPath.indexOf(splitPath[BRANCH])+splitPath[BRANCH].length+1);
    }

    if(!parameters.fileName || parameters.fileName==""){
        info.downloadFileName = info.rootName;
    } else {
        info.downloadFileName = parameters.fileName;
    }

    if(parameters.rootDirectory == "false"){
        info.rootDirectoryName = "";
    } else if (!parameters.rootDirectory || parameters.rootDirectory=="" ||
        parameters.rootDirectory=="true"){
        info.rootDirectoryName = info.rootName+"/";
    } else {
        info.rootDirectoryName = parameters.rootDirectory+"/";
    }

    return info;
}


var basicOptions = {
    method: "get",
    responseType: 'arrayBuffer'
};

function downloadDirectory(){

    var dirPaths = [];
    var files = [];
    var requestPromises = [];

    dirPaths.push(repoInfo.resPath);
    iterateDirectory(dirPaths, files, requestPromises);
}

function iterateDirectory(dirPaths, files, requestPromises){

    axios({
        ...basicOptions,
        url: repoInfo.urlPrefix+dirPaths.pop()+repoInfo.urlPostfix,
        ...authentication
    }).then(function(response) {

        for(var i=0; i<response.data.length-1; i++){
            if(response.data[i].type == "dir"){
                dirPaths.push(response.data[i].path);
            } else {
                if(response.data[i].download_url) {
                    var promise = fetchFile(response.data[i].path, response.data[i].download_url, files);
                    requestPromises.push(promise);
                } else {
                    console.log(response.data[i]);
                }
            }
        }

        // Save files after we iterate all the directories
        if(dirPaths.length <= 0){
            saveFiles(files, requestPromises);
        } else {
            iterateDirectory(dirPaths, files, requestPromises);
        }
    }).catch(function(error){
        processClientError(error);
    });
}

function extractFilenameAndDirectoryFrom(path) {

     var components = path.split('/');
     var filename = components[components.length-1];
     var directory = path.substring(0, path.length-filename.length);

     return {
         filename: filename,
         directory: directory
     };
}

function saveFiles(files, requestPromises){

    var rootDir = outputDirectory + repoInfo.rootDirectoryName;
    shell.mkdir('-p', rootDir);

    Promise.all(requestPromises).then(function(data) {

        for(let i=0; i<files.length-1; i++) {

            var pathForSave = extractFilenameAndDirectoryFrom(files[i].path.substring(decodeURI(repoInfo.resPath).length+1));
            var dir = rootDir + pathForSave.directory;

            fs.exists(dir, function (i,dir, pathForSave, exists) {
                if (!exists) {
                    shell.mkdir('-p', dir);
                }
                save(files[i].data, dir + pathForSave.filename, (err, data) => {
                    if (err) throw err;
                })
            }.bind(null, i, dir, pathForSave));
         }
    });
}

function processClientError(error) {
    if (error.response.status == "401") {
        // Unauthorized
        console.error("Bad credentials, please check your username or password(or access token)!");
    } else if (error.response.status == "403"){
        // API rate limit exceeded
        console.error("API rate limit exceeded, Authenticated requests get a higher rate limit." +
            " Check out the documentation for more details. https://developer.github.com/v3/#rate-limiting");
    } else {
        console.error(error.message);
    }
}
function fetchFile(path, url, files) {

    return axios({
            ...basicOptions,
            url,
            ...authentication
        }).then(function (file) {
            console.log("downloading ", path);
            files.push({path: path, data: file.data});
        }).catch(function(error) {
            processClientError(error);
        });
}

function downloadFile(url) {

    console.log("downloading ", repoInfo.resPath);

    axios({
        ...basicOptions,
        url,
        ...authentication
    }).then(function (file) {
        shell.mkdir('-p', outputDirectory);
        var pathForSave = extractFilenameAndDirectoryFrom(decodeURI(repoInfo.resPath));

        save(file.data, outputDirectory + pathForSave.filename, (err, data) => {
            if (err) throw err;
        })
    }).catch(function(error){
        processClientError(error);
    });
}

var repoInfo = {};
function initializeDownload(parameters) {
    repoInfo = parseInfo(parameters);

    if(!repoInfo.resPath || repoInfo.resPath==""){
        if(!repoInfo.branch || repoInfo.branch==""){
            repoInfo.branch = "master";
        }

        // Download the whole repository
        var repoUrl = `https://github.com/${repoInfo.author}/${repoInfo.repository}/archive/${repoInfo.branch}.zip`;

        axios({
             ...basicOptions,
             responseType: 'stream',
             url: repoUrl,
             ...authentication
        }).then(function(response){
             shell.mkdir('-p', outputDirectory);
             var filename = outputDirectory + `${repoInfo.repository}.zip`;
             response.data.pipe(fs.createWriteStream(filename))
                 .on('close', function () {
                               console.log(`${filename} downloaded.`);
                 });
        }).catch(function(error) {
             processClientError(error);
        });
    } else {
        // Download part of repository
        axios({
            ...basicOptions,
            url: repoInfo.urlPrefix+repoInfo.resPath+repoInfo.urlPostfix,
            ...authentication
        }).then(function(response) {
            if(response.data instanceof Array){
                downloadDirectory();
            } else {
                downloadFile(response.data.download_url);
            }
        }).catch(function(error) {
            processClientError(error);
        });
    }
}

initializeDownload(parameters);
