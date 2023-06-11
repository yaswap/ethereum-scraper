#!/bin/bash
. /home/yacmine/.nvm/nvm.sh
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
cd $SCRIPT_DIR
nvm use
# 7 days shrink log and database
shrink_duration="604800"
occurrence_duration="180"

monitor () {
    last_occurrence=`date +%s`
    last_shrink=`date +%s`
    while true; do
        sleep 60
        temp_occurrence=`grep "Complete handleBlock" output.log | tail -1 | awk '{print $1}' | xargs -i date -d "{}" "+%s"`
        current_timestamp=`date +%s`
        if [ -z "$temp_occurrence" ] || (( $temp_occurrence == $last_occurrence )); then
            no_occurrence_duration=$(($current_timestamp-$last_occurrence))
            echo "Monitor process: Block hasn't been processed for $no_occurrence_duration seconds" >> output.log
            if (( $no_occurrence_duration >= $occurrence_duration )); then
                echo "Monitor process: Force killing ethereum_scraper !!!" >> output.log
                last_occurrence=`date +%s`
                cat scraper.pid | xargs kill -9
                rm -rf scraper.pid
            fi
        else
            last_occurrence=$temp_occurrence
            echo "Monitor process: Last block processing timestamp = $last_occurrence" >> output.log
        fi
        current_shrink_duration=$(($current_timestamp-$last_shrink))
        if (( $current_shrink_duration >= $shrink_duration )); then
            database_name=`grep -i "MONGO_URI" .env | awk -F / '{print $NF}'`
            echo "Shrink log and database" > output.log
            mongo $database_name --eval "db.dropDatabase();"
            last_shrink=`date +%s`
        fi
    done
}

monitor &
while true; do
    sleep 1
    DEBUG=scraper npm start >> output.log 2>&1
    echo "Restart ethereum_scraper !!!" >> output.log
done
