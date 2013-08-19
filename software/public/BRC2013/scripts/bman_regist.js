/**
 * reg_cache.js
 * This file is based on the YATE Project http://YATE.null.ro
 *
 * SIP/IAX caching proxy to mobile registrar implemented in Javascript
 *
 * Yet Another Telephony Engine - a fully featured software PBX and IVR
 * Copyright (C) 2012 Null Team
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA.
 */

#require "bman.js"
#require "libsql.js"

sms_attempts= 3;


/* on every register request
 * 0. if the imsi belongs to att we reject the phone and tell it to go to hell
 * 1. if the imsi was never seen before we will alocate a random 5 digit number and send an sms with instructions on how change the msisdn.
 * 2. we update/set the location.
 *
 * WE DON'T CARE IF THE PHONE IS OFFLINE OR LOST IN SPACE OR IN THE PORTA POTTY.
 *
 */
function onRegister(msg)
{
	// TODO: This needs to be updated to deal with the wired phones.

    if (msg.number == "" || msg.data == "")
	return false;
    if (msg.number !== undefined) {
	if (msg.number.substr(0,4) == "IMSI")
	    imsi = msg.number.substr(4);
    }
    Engine.debug(Engine.DebugInfo,"found imsi " + imsi + " from " + msg.number);
    if (imsi.match(/^310410/))
	return false;
    var loc = sqlStr(msg.data);
    var num = sqlStr(msg.number);
    var imsisql = sqlStr(imsi);
    query = "SELECT location FROM register where imsi=" + imsisql + "";
    Engine.debug(Engine.DebugInfo,query);
    var res = rowQuery(query);
    if (res) {
	if (res.calls === null)
	    res.calls = 0;
	query = "UPDATE register SET location=" + loc + " WHERE imsi=" + imsisql;
	sqlQuery(query);
    	Engine.debug(Engine.DebugInfo,"found imsi " + imsisql + " in location " + res.location);
    } 
    else {	
	var num = newnumber();
	query = "INSERT INTO register (imsi,msisdn,location) VALUES (" + imsisql + "," + sqlStr(num) +"," + loc + ")";
	sqlQuery(query);
	message("Welcome to Legba! Your on-playa phone number is " + num + ".", num);
	Engine.debug(Engine.DebugInfo,query);
    }

}



function randomint(modulus)
{
    if (randomint.counter==undefined) {
	
	var d = new Date();
	randomint.count = d.getSeconds()*1000 + d.getMilliseconds();
	//randomint.count = Math.random();
    }
    randomint.count++;
    // Knuth's integer hash.
    var hash =(randomint.count * 2654435761) % 4294967296;
    return hash % modulus;
}


function goodnumber()
{
   // var An = 2 + randomint(8);
    var An = 2 + randomint(10);
    var A = An.toString();
    var Bn = randomint(10);
    var B = Bn.toString();
    var Cn = randomint(10);
    var C = Cn.toString();
    var Dn = randomint(10);
    var D = Dn.toString();
    var En = randomint(10);
    var E = En.toString();

    switch (randomint(17)) {
	// 4 digits in a row - There are 10,000 of each.
        case 0: return A+B+C+D+D+D+D;
        case 1: return A+B+C+C+C+C+D;
        case 2: return A+B+B+B+B+C+D;
        case 3: return A+A+A+A+B+C+D;
        // ABCBA palidromes - There are about 100,000 of each.
        case 4: return A+B+C+B+A+D+E;
        case 5: return A+B+C+D+B+A+E;
        case 6: return A+B+C+D+E+D+C;
        // ABCCBA palidromes - There are about 10,000 of each.
        case 7: return A+B+C+C+B+A+D;
        case 8: return A+B+C+D+D+C+B;
        // ABCABC repeats - There are about 10,000 of each.
        case 9: return A+B+C+A+B+C+D;
        case 10: return A+B+C+D+B+C+D;
        // AABBCC repeats - There are about 10,000 of each.
        case 11: return A+A+B+B+C+C+D;
        case 12: return A+B+B+C+C+D+D;
	// 4-digit straights - There are about 1,000 of each.
	case 13: return "2345"+B+C+D;
	case 14: return A+"1234"+B+C;
	case 15: return A+B+"1234"+C;
	case 16: return A+B+C+"1234";
    }
}

function numberavailable(val)
{
	var query = "SELECT msisdn FROM register WHERE msisdn=" + sqlStr(val);
	var res = sqlQuery(query);
	return res;
}

function newnumber()
{
    val = goodnumber();
    while (!numberavailable(val)) {
	val = goodnumber();
	Engine.debug(Engine.DebugInfo,val);
    }
    return val;
}

function message(text,dest)
{
	
    var when = "ADDTIME(NOW(),'00:00:20')";
    var query = "INSERT INTO text_sms(imsi,msisdn,dest,next_try,tries,msg)";
    query += " VALUES('001170000000010','6611',"
	+ sqlStr(dest) + "," + when + "," + sqlNum(sms_attempts) + ","
	+ sqlStr(text) + ")";
    query += "; SELECT LAST_INSERT_ID()";
	Engine.debug(Engine.DebugInfo,"this is the message " + query);
    var id = valQuery(query);

}

Engine.debugName("bman_regist");
Message.trackName("bman_regist");
Message.install(onRegister,"user.register",80);
