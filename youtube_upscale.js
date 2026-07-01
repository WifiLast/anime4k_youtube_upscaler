// ==UserScript==
// @name         Youtube Enhancement Script
// @namespace    YoutubeEnhancementScript
// @version      1.1
// @description  Disable autoplay on Youtube
// @author       Devrim
// @match        https://www.youtube.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/////////////////////////////////////
/////////////////////////////////////
/////DISABLE AUTO PLAY///////////////
/////////////////////////////////////
/////////////////////////////////////

/////////////////////////////////////
//First method, this sometimes fails/ 
//for some reason////////////////////
/////////////////////////////////////

var vid = document.getElementsByClassName("html5-main-video")[0];
vid.addEventListener('loadeddata', function() {
   vid.pause();
}, true);



/////////////////////////////////////
//Second method//////////////////////
/////////////////////////////////////

var vids = document.getElementsByClassName("video-stream");
    var controls = document.getElementsByClassName("ytp-play-button");
    var status = controls[0].getAttribute("aria-label");
    if (status == "Pause") { 
        controls[0].click();
};



/////////////////////////////////////
/////////////////////////////////////
/////CHOOSE RESOLUTION///////////////
/////////////////////////////////////
/////////////////////////////////////

(function() {

    "use strict";

    // --- SETTINGS -------

    // Target Resolution to always set to. If not available, the next best resolution will be used.
    const changeResolution = true;
    const targetRes = "hd2160";
    // Choices for targetRes are currently:
    //   "highres" >= ( 8K / 4320p / QUHD  )
    //   "hd2880"   = ( 5K / 2880p /  UHD+ )
    //   "hd2160"   = ( 4K / 2160p /  UHD  )
    //   "hd1440"   = (      1440p /  QHD  )
    //   "hd1080"   = (      1080p /  FHD  )
    //   "hd720"    = (       720p /   HD  )
    //   "large"    = (       480p         )
    //   "medium"   = (       360p         )
    //   "small"    = (       240p         )
    //   "tiny"     = (       144p         )

    // If changePlayerSize is true, then the video's size will be changed on the page
    //   instead of using youtube's default (if theater mode is enabled).
    // If useCustomSize is false, then the player will be resized to try to match the target resolution.
    //   If true, then it will use the customHeight and customWidth variables.
    const changePlayerSize = false;
    const useCustomSize = false;
    const customHeight = 600, customWidth = 1280;

    // If autoTheater is true, each video page opened will default to theater mode.
    // This means the video will always be resized immediately if you are changing the size.
    // NOTE: YouTube will not always allow theater mode immediately, the page must be fully loaded first.
    const autoTheater = false;

    // If flushBuffer is false, then the first second or so of the video may not always be the desired resolution.
    //   If true, then the entire video will be guaranteed to be the target resolution, but there may be
    //   a very small additional delay before the video starts if the buffer needs to be flushed.
    const flushBuffer = true;

    // --------------------




    // --- GLOBALS --------


    const DEBUG = false;

    // Possible resolution choices (in decreasing order, i.e. highres is the best):
    const resolutions = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
    // youtube is always 16:9 right now, but has to be at least 480x270 for the player UI
    const heights = [4320, 2880, 2160, 1440, 1080, 720, 480, 360, 270, 270];
    const widths = [7680, 5120, 3840, 2560, 1920, 1280, 854, 640, 480, 480];

    let doc = document, win = window;


    // --------------------


    function debugLog(message)
    {
        if (DEBUG)
        {
            console.log("Youtube Enhancement Script | " + message);
        }
    }


    // --------------------


    // Get video ID from the currently loaded video (which might be different than currently loaded page)
    function getVideoIDFromURL(ytPlayer)
    {
        const idMatch = /(?:v=)([\w\-]+)/;
        let videoURL = ytPlayer.getVideoUrl();
        let id = idMatch.exec(videoURL)[1] || "ERROR: idMatch failed; youtube changed something";

        return id;
    }


    // --------------------


    // Attempt to set the video resolution to desired quality or the next best quality
    function setResolution(ytPlayer, resolutionList)
    {
        debugLog("Setting Resolution...");

        // Youtube doesn't return "auto" for auto, so set to make sure that auto is not set by setting
        //   even when already at target res or above, but do so without removing the buffer for this quality
        if (resolutionList.indexOf(targetRes) >= resolutionList.indexOf(ytPlayer.getPlaybackQuality()))
        {
            ytPlayer.setPlaybackQuality(targetRes);
            debugLog("Resolution Set To: " + targetRes);
            return;
        }

        const end = resolutionList.length - 1;
        let nextBestIndex = Math.max(resolutionList.indexOf(targetRes), 0);
        let ytResolutions = ytPlayer.getAvailableQualityLevels();
        debugLog("Available Resolutions: " + ytResolutions.join(", "));

        while ( (ytResolutions.indexOf(resolutionList[nextBestIndex]) === -1) && nextBestIndex < end )
        {
            ++nextBestIndex;
        }

        if (flushBuffer && ytPlayer.getPlaybackQuality() !== resolutionList[nextBestIndex])
        {
            let id = getVideoIDFromURL(ytPlayer);
            if (id.indexOf("ERROR: ") === -1)
            {
                let pos = ytPlayer.getCurrentTime();
                ytPlayer.loadVideoById(id, pos, resolutionList[nextBestIndex]);
            }

            debugLog("ID: " + id);
        }
        ytPlayer.setPlaybackQuality(resolutionList[nextBestIndex]);

        debugLog("Resolution Set To: " + resolutionList[nextBestIndex]);
    }


    // --------------------


    // Set resolution, but only when API is ready (it should normally already be ready)
    function setResOnReady(ytPlayer, resolutionList)
    {
        if (ytPlayer.getPlaybackQuality === undefined)
        {
            win.setTimeout(setResOnReady, 100, ytPlayer, resolutionList);
        }
        else
        {
            setResolution(ytPlayer, resolutionList);

            let storedQuality = localStorage.getItem("yt-player-quality");
            if (!storedQuality || storedQuality.indexOf(targetRes) === -1)
            {
                let tc = Date.now(), te = tc + 2592000000;
                localStorage.setItem("yt-player-quality","{\"data\":\"" + targetRes + "\",\"expiration\":" + te + ",\"creation\":" + tc + "}");
            }
        }
    }


    // --------------------


    function setTheaterMode(ytPlayer)
    {
        debugLog("Setting Theater Mode");

        if (win.location.href.indexOf("/watch") !== -1)
        {
            let page = doc.getElementById("page");
            let pageManager = doc.getElementsByTagName("ytd-watch")[0];

            if (ytPlayer && page)
            {
                // Wait until youtube has already set the page class, so it doesn't overwrite the theater mode change
                let isLoaded = doc.body.classList.contains("page-loaded");
                if (page.className.indexOf(getVideoIDFromURL(ytPlayer)) === -1 || !isLoaded)
                {
                    win.setTimeout(setTheaterMode, 250, ytPlayer);
                }
                if (isLoaded)
                {
                    page.classList.remove("watch-non-stage-mode");
                    page.classList.add("watch-stage-mode", "watch-wide");
                    win.dispatchEvent(new Event("resize"));
                }
            }
            else if (pageManager)
            {
                pageManager.setAttribute("theater", "true");
                pageManager.setAttribute("theater-requested_", "true");
                win.dispatchEvent(new Event("resize"));
            }
        }
    }


    // --------------------


    // resize the player
    function resizePlayer(width, height)
    {
        debugLog("Setting video player size");

        let left, playlistTop, playlistHeight;
        left = (-width / 2);
        playlistTop = (height - 360);
        playlistHeight = (height - 100);

        let styleContent = " \
        #page.watch-stage-mode .player-height, ytd-watch[theater] #player.style-scope { min-height: " + height + "px !important; } \
        #page.watch-stage-mode .player-width, ytd-watch[theater] #player.style-scope { min-width: " + width + "px !important; } \
        #page.watch-stage-mode .player-width { left: " + left + "px !important; } \
        #page.watch-stage-mode #watch-appbar-playlist { top: " + playlistTop + "px !important; } \
        #page.watch-stage-mode #playlist-autoscroll-list { max-height: " + playlistHeight + "px !important; } \
        ";

        let ythdStyle = doc.getElementById("ythdStyleSheet");
        if (!ythdStyle)
        {
            ythdStyle = doc.createElement("style");
            ythdStyle.type = "text/css";
            ythdStyle.id = "ythdStyleSheet";
            ythdStyle.innerHTML = styleContent;
            doc.head.appendChild(ythdStyle);
        }
        else
        {
            ythdStyle.innerHTML = styleContent;
        }

        win.dispatchEvent(new Event("resize"));
    }


    // --- MAIN -----------


    function main()
    {
        let ytPlayer = doc.getElementById("movie_player") || doc.getElementsByClassName("html5-video-player")[0];

        if (autoTheater && ytPlayer)
        {
            setTheaterMode(ytPlayer);
        }

        if (changePlayerSize && win.location.host.indexOf("youtube.com") !== -1 && win.location.host.indexOf("gaming.") === -1)
        {
            let width, height;
            if (useCustomSize)
            {
                height = customHeight;
                width = customWidth;
            }
            else
            {
                // don't include youtube search bar as part of the space the video can try to fit in
                let heightOffsetEl = doc.getElementById("masthead-positioner-height-offset") || doc.getElementById("masthead");
                let mastheadContainerEl = doc.getElementById("yt-masthead-container") || doc.getElementById("masthead-container");
                let mastheadHeight = 50, mastheadPadding = 16;
                if (heightOffsetEl && mastheadContainerEl)
                {
                    mastheadHeight = parseInt(win.getComputedStyle(heightOffsetEl).height, 10);
                    mastheadPadding = parseInt(win.getComputedStyle(mastheadContainerEl).paddingBottom, 10) * 2;
                }

                let i = Math.max(resolutions.indexOf(targetRes), 0);
                height = Math.min(heights[i], win.innerHeight - (mastheadHeight + mastheadPadding));
                width = Math.min(widths[i], win.innerWidth);
            }

            resizePlayer(width, height);
        }

        if (changeResolution && ytPlayer)
        {
            setResOnReady(ytPlayer, resolutions);
        }

        if (changeResolution || autoTheater)
        {
            win.addEventListener("loadstart", function(e) {
                if (!(e.target instanceof win.HTMLMediaElement))
                {
                    return;
                }

                ytPlayer = doc.getElementById("movie_player") || doc.getElementsByClassName("html5-video-player")[0];
                if (ytPlayer)
                {
                    debugLog("Loaded new video");
                    if (changeResolution)
                    {
                        setResOnReady(ytPlayer, resolutions);
                    }
                    if (autoTheater)
                    {
                        setTheaterMode(ytPlayer);
                    }
                }
            }, true );
        }

        win.removeEventListener("yt-navigate-finish", main, true );
    }

    main();
    // Youtube doesn't load the page immediately in new version so you can watch before waiting for page load
    // But we can only set resolution until the page finishes loading
    win.addEventListener("yt-navigate-finish", main, true );

})();

/////////////////////////////////////
/////////////////////////////////////
/////DISABLE AUTO PLAY///////////////
/////OF SUGGESTED VIDEO//////////////
/////////////////////////////////////
function its_magic(t, n, e) {
	return t.evaluate(e, n, null, 7, null)
}

function find_stuff(t) {
	return its_magic(document, document, t)
}

function autoplay(t) {
	var n = find_stuff("//paper-toggle-button").snapshotItem(0);
	if ((!new_design && 0 != n.offsetWidth || new_design && "true" == n.getAttribute("aria-pressed")) && t >= 0) {
		var e = find_stuff("//*[@id='toggleButton']").snapshotItem(0);
		if (e) {
			var c = document.createEvent("MouseEvents");
			c.initEvent("click", !0, !0), e.dispatchEvent(c)
		}
	}
}

function check_changes() {
	20 > nochanges_count && nochanges_count++, 20 > counter_stuff && counter_stuff++, 20 > nochanges_count && autoplay(counter_stuff)
}
var new_design = "body" != document.body.id,
	nochanges_count = -1,
	counter_stuff = -1;
window.setInterval(check_changes, 1e3), check_changes();