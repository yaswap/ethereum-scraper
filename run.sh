#!/bin/bash
. /home/yacmine/.nvm/nvm.sh
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
cd $SCRIPT_DIR
nvm use
while true; do
    sleep 1
    node index.js
    if [ $? -eq 1 ]
    then
        X=$(< scraper.pid)
        echo $X
        kill -9 $X 2>/dev/null
        rm -rf scraper.pid
    fi
done
